import { z } from 'zod'
import { query, withTransaction } from '../db/pool.js'
import { AppError } from '../lib/AppError.js'
import { getSignedUrl } from '../lib/mediaProvider.js'
import { findWorker, workerAccessFor } from '../lib/workers.js'
import { addToCatalogue, describeBehavior, resolveCategory } from '../lib/catalogue.js'

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v))

const localityName = z.string().trim().min(1, 'יש לבחור יישוב').max(120)

/**
 * Where and when - shared by catalogue and custom Hooks.
 *
 * The locality is OPTIONAL here, and the catalogue schema puts the
 * requirement back on top. The two forms differ on purpose: the catalogue
 * describes a known behaviour, where the place is most of what makes the
 * report useful in aggregate; the custom form is where someone goes when
 * nothing on the list fits, and stopping them over a field they may not be
 * able to fill means the report never gets filed at all.
 */
const momentFields = {
  localityName: localityName.optional(),
  localityCode: z
    .string()
    .trim()
    .regex(/^\d{1,6}$/)
    .optional(),

  occurredAt: z.iso.datetime({ offset: true }).optional(),
  occurredText: optionalText(120),

  notes: optionalText(1000),
}

export const TARGET_TYPES = ['employee', 'my_org', 'local_authority', 'business']

export const createReportSchema = z
  .object({
    behaviorId: z.uuid('התנהגות לא תקינה'),
    // Locality stays optional HERE and is required by the handler for work
    // and community. The consumption form asks for a business instead, and
    // which form applies depends on the behaviour's space - read from the
    // catalogue row, not the request, so a schema cannot decide it.
    ...momentFields,
    photoPublicId: optionalText(200),

    // Consumption space only (migration 030). The business itself travels
    // as targetType 'business' + targetName.
    businessAddress: optionalText(200),
    staffName: optionalText(120),
    placeText: optionalText(200),

    // Who the Hook is about. Optional here and required by the HANDLER for
    // the work space, because whether it is required depends on the
    // behaviour's space - which is read from the catalogue row, not from
    // the request. A schema cannot see that and must not guess at it.
    targetType: z.enum(TARGET_TYPES).optional(),
    targetName: optionalText(120),
    targetWorkerId: z.uuid('עובד/ת לא תקין/ה').optional(),
  })
  .refine((v) => !(v.localityCode && !v.localityName), {
    message: 'יש לציין את שם היישוב',
    path: ['localityName'],
  })
  .refine((v) => v.targetType !== 'employee' || v.targetWorkerId || v.targetName, {
    message: 'יש לבחור עובד/ת מהרשימה או להקליד שם',
    path: ['targetName'],
  })

/** A behaviors.category_key: the slugs the catalogue already uses. */
export const categoryKeySchema = z.string().trim().regex(/^[a-z0-9_]{1,60}$/, 'קטגוריה לא תקינה')

export const createCustomReportSchema = z
  .object({
    space: z.enum(['work', 'community', 'consumption']),
    description: z.string().trim().min(3, 'יש לתאר את ה-Hook').max(200),

    // At most one: an existing category, or the name of a proposed one.
    // Neither means the reporter chose "ללא קטגוריה" - the system admin
    // then picks one at approval, since a behaviors row cannot exist
    // without a category (migration 025, approveMessage).
    categoryKey: categoryKeySchema.optional(),
    categoryLabel: optionalText(80),

    targetType: z.enum(TARGET_TYPES, 'יש לבחור על מי ה-Hook'),
    targetName: optionalText(120),
    // An employee picked from the colleagues list (org_workers.worker_id).
    // The name is then looked up server-side, never taken from the client.
    targetWorkerId: z.uuid('עובד/ת לא תקין/ה').optional(),
    ...momentFields,
  })
  .refine((v) => !(v.categoryKey && v.categoryLabel), {
    message: 'יש לבחור קטגוריה אחת',
    path: ['categoryKey'],
  })
  // A CBS code with no name would store half a locality: a row that can be
  // counted in aggregate but not shown to anyone. The form always sends
  // both or neither; this stops anything else from reaching the column.
  .refine((v) => !(v.localityCode && !v.localityName), {
    message: 'יש לציין את שם היישוב',
    path: ['localityName'],
  })
  .refine((v) => v.targetType !== 'employee' || v.targetWorkerId || v.targetName, {
    message: 'יש לבחור עובד/ת מהרשימה או להקליד שם',
    path: ['targetName'],
  })
  // A name means something only for the two targets that ask for one, and a
  // worker id only for an employee.
  .transform((v) => ({
    ...v,
    targetName: v.targetType === 'employee' || v.targetType === 'business' ? v.targetName : undefined,
    targetWorkerId: v.targetType === 'employee' ? v.targetWorkerId : undefined,
  }))

/**
 * Which organisation a report belongs to.
 *
 * A plain read of the reporter's resolved pointer. It used to join
 * organizations to profiles on a registry number, which was wrong twice over:
 * the column was not unique, so the match could be ambiguous, and the two
 * sides were written in different formats, so it could silently miss.
 * Migration 012 made organizations.registry_id unique and normalised, and
 * profiles.organization_id is now kept in step by trigger.
 *
 * Still resolved server-side from the reporter, never accepted from the
 * request: a client that could name the organisation could file reports into
 * someone else's dashboard.
 */
async function organizationForReporter(userId) {
  const { rows } = await query(
    `select organization_id from public.profiles where id = $1`,
    [userId],
  )
  return rows[0]?.organization_id ?? null
}

/**
 * File a report.
 *
 * The reporter is stored. It is never shown to the organisation - see the
 * header of migration 011 and `listOrganizationReports` below.
 */
export async function createReport(req, res) {
  const body = req.body

  // The space comes from the catalogue row, never from the request. A client
  // could otherwise file a work-space report against a community behaviour
  // and land it in the wrong organisation's dashboard.
  const { rows: behaviors } = await query(
    `select id, space, name from public.behaviors where id = $1 and is_active`,
    [body.behaviorId],
  )

  const behavior = behaviors[0]
  if (!behavior) throw AppError.badRequest('ההתנהגות שנבחרה אינה זמינה.')

  const organizationId = await organizationForReporter(req.user.id)

  // A work-space Hook is about someone, and the rule hangs on the SPACE -
  // which comes from the catalogue row above, never from the request. A
  // client that omits the target cannot file an unattributed work Hook by
  // claiming a different space.
  if (behavior.space === 'work' && !body.targetType) {
    throw AppError.badRequest('יש לציין על מי או על מה ה-Hook.')
  }

  // Each space's required "where", decided by the catalogue row's space:
  //   consumption  the business (the town comes along with it if picked)
  //   otherwise    the locality, as before
  const consumption = behavior.space === 'consumption'
  if (consumption) {
    if (body.targetType && body.targetType !== 'business') {
      throw AppError.badRequest('ב־Hook במרחב הצריכה יש לציין עסק.')
    }
    if (!body.targetName) throw AppError.badRequest('יש לציין את שם העסק.')
    body.targetType = 'business'
  } else if (!body.localityName) {
    throw AppError.badRequest('יש לבחור יישוב או להשתמש בזיהוי מיקום.')
  }

  // A picked colleague must be in the reporter's own organisation - the
  // same scope the list or search was served from (workerAccessFor). The
  // name stored is the list's, so a client cannot attach one person's id
  // to another's name. Identical to createCustomReport, deliberately: two
  // rules for the same question is how one of them goes stale.
  let targetName = body.targetName ?? null
  if (body.targetWorkerId) {
    const access = await workerAccessFor(req.user.id)
    const worker = access && (await findWorker(access.organizationId, body.targetWorkerId))
    if (!worker) throw AppError.badRequest('העובד/ת שנבחר/ה אינו/ה ברשימת הארגון שלך.')
    targetName = worker.full_name
  }

  const { rows } = await query(
    `insert into public.reports
       (space, behavior_id, behavior_name, locality_code, locality_name,
        occurred_at, occurred_text, notes, photo_public_id,
        target_type, target_name, target_worker_id,
        business_address, staff_name, place_text,
        user_id, organization_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $15, $16, $17, $13, $14)
     returning id, created_at`,
    [
      behavior.space,
      behavior.id,
      behavior.name,
      body.localityCode ?? null,
      body.localityName ?? null,
      body.occurredAt ?? null,
      body.occurredText ?? null,
      body.notes ?? null,
      body.photoPublicId ?? null,
      body.targetType ?? null,
      targetName,
      body.targetWorkerId ?? null,
      req.user.id,
      organizationId,
      // Consumption only - dropped for any other space rather than stored
      // where nothing reads them.
      consumption ? (body.businessAddress ?? null) : null,
      consumption ? (body.staffName ?? null) : null,
      consumption ? (body.placeText ?? null) : null,
    ],
  )

  // NO MESSAGE ROW HERE, deliberately. public.messages is the approval
  // queue: a row in it is something staff must DECIDE. A Hook filed
  // against a behaviour already in the catalogue proposes nothing, so
  // there is nothing to decide and it does not belong here.
  //
  // Every Hook is still visible to staff - HOOKS של משתמשים lists them
  // all, with filters and a review-status column. That page is the answer
  // to "show me everything"; this queue answers "what needs me".
  res.status(201).json({ filed: true, id: rows[0].id, createdAt: rows[0].created_at })
}

/**
 * File a Hook about a behaviour that is not in the catalogue.
 *
 * There is no catalogue row to take the space from, so it is the one field
 * here the client declares. That is safe because routing never depended on
 * it: the organisation still comes from the reporter's profile.
 *
 * behavior_id is left null - that is what marks the row as custom - and the
 * reporter's own wording goes into behavior_name. See migration 023.
 */
export async function createCustomReport(req, res) {
  const body = req.body

  // A chosen category must be one this space actually has - otherwise the
  // approval would file the behaviour under a card that does not exist.
  if (body.categoryKey) {
    const { rows: known } = await query(
      `select 1 from public.behaviors where space = $1 and category_key = $2 and is_active limit 1`,
      [body.space, body.categoryKey],
    )
    if (!known.length) throw AppError.badRequest('הקטגוריה שנבחרה אינה קיימת במרחב הזה.')
  }

  const organizationId = await organizationForReporter(req.user.id)

  // A system admin IS the approver, so their Hook skips the queue and joins
  // the catalogue at once. Read from profiles, never from the request - the
  // same rule as requireSystemAdmin.
  const { rows: me } = await query(`select user_type from public.profiles where id = $1`, [
    req.user.id,
  ])
  const direct = me[0]?.user_type === 'system_admin'
  // A catalogue row cannot exist without a category, so "ללא קטגוריה" -
  // which means "let the reviewer decide" - has no meaning here.
  if (direct && !body.categoryKey && !body.categoryLabel) {
    throw AppError.badRequest('ה-Hook נוסף ישירות לרשימה, ולכן יש לבחור קטגוריה או לתת שם לקטגוריה חדשה.')
  }

  // A picked colleague must be in the reporter's own organisation - the same
  // scope the list or search was served from (workerAccessFor). The name
  // stored is the list's, so a client cannot attach one person's id to
  // another's name.
  let targetName = body.targetName ?? null
  if (body.targetWorkerId) {
    const access = await workerAccessFor(req.user.id)
    const worker = access && (await findWorker(access.organizationId, body.targetWorkerId))
    if (!worker) throw AppError.badRequest('העובד/ת שנבחר/ה אינו/ה ברשימת הארגון שלך.')
    targetName = worker.full_name
  }

  // The report and its review message are written together. A Hook outside
  // the catalogue that reached the database without reaching the queue would
  // sit there unreviewed with nothing pointing at it, and nobody would know
  // to look - so either both land or neither does.
  const filed = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into public.reports
         (space, behavior_id, behavior_name, category_key, category_label,
          target_type, target_name, target_worker_id,
          locality_code, locality_name, occurred_at, occurred_text, notes,
          user_id, organization_id)
       values ($1, null, $2, $12, $13, $3, $4, $14, $5, $6, $7, $8, $9, $10, $11)
       returning id, created_at`,
      [
        body.space,
        body.description,
        body.targetType,
        targetName,
        body.localityCode ?? null,
        // Null when the reporter did not name a place: optional on this
        // form, and nullable on the column as of migration 028.
        body.localityName ?? null,
        body.occurredAt ?? null,
        body.occurredText ?? null,
        body.notes ?? null,
        req.user.id,
        organizationId,
        body.categoryKey ?? null,
        body.categoryLabel ?? null,
        body.targetWorkerId ?? null,
      ],
    )

    const report = rows[0]

    // Named at write time rather than joined at read time: a reviewer should
    // see what the account was called when the Hook was filed, even if it is
    // renamed or deleted afterwards. Falls back to the email, then to a
    // placeholder - a nameless account must still be reviewable.
    const { rows: who } = await client.query(
      `select coalesce(nullif(full_name, ''), nullif(email, ''), 'משתמש/ת ללא שם') as name
         from public.profiles where id = $1`,
      [req.user.id],
    )

    // System admin: straight into the catalogue, through the same code an
    // approval uses (lib/catalogue.js), and the report points at it.
    let behavior = null
    if (direct) {
      const category = await resolveCategory(client, body.space, {
        key: body.categoryKey ?? null,
        label: body.categoryKey ? null : (body.categoryLabel ?? null),
      })
      behavior = await addToCatalogue(client, {
        space: body.space,
        name: body.description,
        category,
      })
      await client.query(`update public.reports set behavior_id = $1 where id = $2`, [
        behavior.id,
        report.id,
      ])
    }

    // Every custom Hook gets a message row. A system admin's is written
    // already approved, by themselves: it never waits in the queue, but the
    // "approved" tab still shows where every catalogue addition came from.
    await client.query(
      `insert into public.messages
         (user_id, user_name, new_hook_text, message_type, report_id,
          status, handled_at, handled_by, handling_note, behavior_id)
       values ($1, $2, $3, 'new_hook', $4,
               $5, case when $5 = 'approved' then now() end,
               case when $5 = 'approved' then $1::uuid end, $6, $7)
       on conflict (report_id) where report_id is not null
       do update set new_hook_text = excluded.new_hook_text, date = now()`,
      [
        req.user.id,
        who[0]?.name ?? null,
        body.description,
        report.id,
        direct ? 'approved' : 'pending',
        direct ? 'נוסף ישירות על ידי מנהל/ת מערכת' : null,
        behavior?.id ?? null,
      ],
    )

    return { report, behavior }
  })

  res.status(201).json({
    filed: true,
    id: filed.report.id,
    createdAt: filed.report.created_at,
    // Set only for a system admin: the Hook is already in the catalogue.
    addedToCatalogue: filed.behavior ? describeBehavior(filed.behavior) : null,
  })
}

/* ------------------------------------------------- the org admin's view */

export const orgReportsQuerySchema = z.object({
  space: z.enum(['work', 'community', 'consumption']).default('work'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
})

/**
 * Reports for the caller's own organisation.
 *
 * THE COLUMN LIST IS THE SECURITY BOUNDARY. `user_id` is absent and must stay
 * absent - never `select *` here, and never add a join back to profiles or
 * auth.users. `target_name` stays out for the same reason in reverse: it can
 * name the employee a Hook is about, and flags are theirs, not their
 * manager's (migration 023). An org admin is frequently the person a report is about, so the
 * reporter's identity reaching this response is the one failure that matters.
 *
 * photo_public_id is selected but deliberately NOT returned: it is exchanged
 * for a freshly signed link below, so the raw id never leaves the server.
 *
 * The organisation comes from `req.orgAdmin`, which requireOrgAdmin read from
 * the database. Nothing about the scope is taken from the request.
 */
export async function listOrganizationReports(req, res) {
  const { space, limit, before } = req.validatedQuery

  const { rows } = await query(
    `select id, space, behavior_id, behavior_name,
            locality_code, locality_name,
            occurred_at, occurred_text, notes, photo_public_id,
            created_at
       from public.reports
      where organization_id = $1
        and space = $2
        and ($3::timestamptz is null or created_at < $3)
      order by created_at desc
      limit $4`,
    [req.orgAdmin.organizationId, space, before ?? null, limit],
  )

  // The photo link is minted here, per request, rather than stored on the
  // row. Without CLOUDINARY_AUTH_TOKEN_KEY a signed Cloudinary URL does not
  // expire, so a stored one would make every database row a permanent,
  // working link to evidence about an identifiable person - and a leaked
  // backup a photo gallery. Minting keeps the link's life tied to a request
  // by an authorised admin, and swapping storage provider stays a one-file
  // change rather than a data migration.
  const reports = rows.map(({ photo_public_id, ...report }) => {
    if (!photo_public_id) return { ...report, photo: null }
    const { url, expiresInSeconds } = getSignedUrl(photo_public_id, { width: 1200 })
    return { ...report, photo: { url, expiresInSeconds } }
  })

  res.json({
    space,
    count: reports.length,
    // Cursor rather than an offset: reports arrive constantly, and an offset
    // would repeat or skip rows as the list shifts underneath.
    nextBefore: reports.length === limit ? reports[reports.length - 1].created_at : null,
    reports,
  })
}
