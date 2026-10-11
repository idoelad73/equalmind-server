/**
 * Approving a Hook with corrections, against the real database, through
 * the real controller. Fixtures are created and deleted here; nothing
 * pre-existing is touched.
 */
import 'dotenv/config'
import { query } from './db/pool.js'
import { approveSchema, approveMessage, listMessages } from './controllers/messages.controller.js'

let bad = 0
const check = (ok, label, detail = '') => {
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
}

const SUFFIX = String(Date.now()).slice(-7)
const REVIEWER = (await query(
  `select id from public.profiles where user_type = 'system_admin' limit 1`)).rows[0].id

const made = { reports: [], messages: [], behaviors: [] }

/** A pending custom Hook, as the filing form would leave one. */
async function fileHook(overrides = {}) {
  const row = {
    space: 'community',
    behavior_name: 'טקסט מקורי ' + SUFFIX,
    target_type: 'business',
    target_name: 'עסק כלשהו',
    locality_name: 'כפר סבא',
    locality_code: '6900',
    occurred_text: 'בשבוע שעבר',
    notes: 'הערות מקוריות',
    ...overrides,
  }
  const { rows: [report] } = await query(
    `insert into public.reports
       (space, behavior_id, behavior_name, target_type, target_name,
        locality_name, locality_code, occurred_text, notes, user_id)
     values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [row.space, row.behavior_name, row.target_type, row.target_name,
     row.locality_name, row.locality_code, row.occurred_text, row.notes, REVIEWER],
  )
  const { rows: [message] } = await query(
    `insert into public.messages (user_id, user_name, new_hook_text, report_id)
     values ($1, 'בודק', $2, $3) returning message_id`,
    [REVIEWER, row.behavior_name, report.id],
  )
  made.reports.push(report.id)
  made.messages.push(message.message_id)
  return { reportId: report.id, messageId: message.message_id, original: row }
}

/** Run the controller the way the route would. */
async function approve(messageId, body) {
  const parsed = approveSchema.safeParse(body)
  if (!parsed.success) return { error: parsed.error.issues[0] }
  let out = null
  const req = { params: { id: messageId }, body: parsed.data, user: { id: REVIEWER } }
  try {
    await approveMessage(req, { json: (b) => { out = b } })
  } catch (error) {
    return { error: { message: error.message } }
  }
  if (out?.behavior?.id) made.behaviors.push(out.behavior.id)
  return out
}

const reportRow = async (id) =>
  (await query(`select * from public.reports where id = $1`, [id])).rows[0]

try {
  /* ---------------------------------------- 1. every field is editable */

  const a = await fileHook()
  const res = await approve(a.messageId, {
    name: 'נוסח מתוקן ' + SUFFIX,
    categoryLabel: 'קטגוריית בדיקה ' + SUFFIX,
    space: 'work',
    targetType: 'local_authority',
    targetName: null,
    localityName: 'חיפה',
    localityCode: '4000',
    occurredText: null,
    occurredAt: '2026-10-01T09:30:00.000Z',
    notes: 'הערות שתוקנו',
  })
  check(!res.error, 'approve with a full edit succeeds', res.error?.message)

  const r = await reportRow(a.reportId)
  check(r.behavior_name === 'נוסח מתוקן ' + SUFFIX, 'the report carries the corrected wording', r.behavior_name)
  check(r.space === 'work', 'space changed', r.space)
  check(r.target_type === 'local_authority' && r.target_name === null, 'target changed and the stale name cleared',
    `${r.target_type} / ${r.target_name}`)
  check(r.locality_name === 'חיפה' && r.locality_code === '4000', 'locality changed',
    `${r.locality_name} / ${r.locality_code}`)
  check(r.occurred_text === null && r.occurred_at !== null, 'free text swapped for a timestamp',
    `${r.occurred_text} / ${r.occurred_at?.toISOString?.()}`)
  check(r.notes === 'הערות שתוקנו', 'notes changed', r.notes)
  check(r.behavior_id !== null, 'and the report now points at the new catalogue row')

  /* -------------------------------------- 2. the original is not lost */

  const { rows: [m] } = await query(
    'select new_hook_text, edits from public.messages where message_id = $1', [a.messageId])
  check(m.edits?.behavior_name?.from === a.original.behavior_name,
    'edits records the wording it replaced', JSON.stringify(m.edits?.behavior_name))
  check(m.edits?.locality_name?.from === 'כפר סבא', 'and the locality it replaced',
    JSON.stringify(m.edits?.locality_name))
  check(m.edits?.notes?.from === 'הערות מקוריות', 'and the notes it replaced')
  check(m.new_hook_text === 'נוסח מתוקן ' + SUFFIX, 'the queue shows the corrected wording too')

  /* ------------------------- 3. approving unchanged records no edit */

  const b = await fileHook()
  const res2 = await approve(b.messageId, {
    name: b.original.behavior_name,
    categoryLabel: 'קטגוריית בדיקה ' + SUFFIX,
    space: b.original.space,
    targetType: b.original.target_type,
    targetName: b.original.target_name,
    localityName: b.original.locality_name,
    localityCode: b.original.locality_code,
    occurredAt: null,
    occurredText: b.original.occurred_text,
    notes: b.original.notes,
  })
  check(!res2.error, 'approving without changes succeeds', res2.error?.message)
  const { rows: [m2] } = await query(
    'select edits from public.messages where message_id = $1', [b.messageId])
  check(m2.edits === null, 'and leaves edits null rather than a no-op record', JSON.stringify(m2.edits))

  /* ------------------------------ 4. the database constraints hold */

  const c = await fileHook({ target_type: 'employee', target_name: 'מישהי' })
  const res3 = await approve(c.messageId, {
    name: c.original.behavior_name,
    categoryLabel: 'קטגוריית בדיקה ' + SUFFIX,
    targetType: 'employee',
    targetName: null,
  })
  check(Boolean(res3.error), 'clearing the name of an employee Hook is refused',
    res3.error?.message)
  check(res3.error?.message?.includes('שם'), 'with a sentence in Hebrew, not a 500',
    res3.error?.message)

  const res4 = await approve(c.messageId, {
    name: c.original.behavior_name,
    categoryLabel: 'קטגוריית בדיקה ' + SUFFIX,
    localityName: null,
    localityCode: '4000',
  })
  check(Boolean(res4.error), 'a locality code with no name is refused', res4.error?.message)

  /* ------------------------------ 5. an already-handled one is a conflict */

  const res5 = await approve(a.messageId, { categoryLabel: 'שוב ' + SUFFIX })
  check(Boolean(res5.error), 'approving twice is a conflict, not a second edit',
    res5.error?.message)

  /* ----------------------------- 6. the queue ships what the panel needs */

  const d = await fileHook()
  let listed = null
  await listMessages(
    { validatedQuery: { status: 'pending', limit: 50 } },
    { json: (b2) => { listed = b2 } },
  )
  const card = listed.messages.find((x) => x.message_id === d.messageId)
  const needed = ['space', 'target_type', 'target_name', 'locality_name', 'locality_code',
                  'occurred_at', 'occurred_text', 'notes', 'category_key', 'edits']
  const missing = needed.filter((k) => !(k in card))
  check(missing.length === 0, 'the list carries every field the edit form shows', missing.join(', '))
  check(!('user_id' in card), 'and still no user_id')
} finally {
  for (const id of made.messages) await query('delete from public.messages where message_id = $1', [id])
  for (const id of made.reports) await query('delete from public.reports where id = $1', [id])
  for (const id of made.behaviors) await query('delete from public.behaviors where id = $1', [id])
  console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
  process.exit(bad ? 1 : 0)
}
