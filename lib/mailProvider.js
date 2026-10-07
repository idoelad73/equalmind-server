import nodemailer from 'nodemailer'
import { AppError } from './AppError.js'
import { env } from '../config/env.js'
import { supabaseAdmin } from '../db/supabase.js'
import { inviteOrgRepresentativeEmail } from './emails/inviteOrgRepresentative.js'

/**
 * The one place the rest of the server sends email.
 *
 * Shaped like mediaProvider and smsProvider for the same reason: the vendor
 * changes and the call sites should not. Today everything goes through
 * Supabase Auth, which is already sending these invitations.
 *
 * TWO THINGS ABOUT THE SUPABASE DRIVER
 *
 * 1. The body is NOT set here. `inviteUserByEmail` renders the "Invite user"
 *    template configured in the Supabase dashboard, globally. Wording changes
 *    go there, not into this file. That is the main reason to ever add the
 *    resend driver below: a per-call body.
 *
 * 2. Supabase's built-in sender only delivers to addresses on the project
 *    team and is capped at a few an hour. A real representative's address
 *    needs custom SMTP configured in the dashboard. Nothing here can detect
 *    that, so a silent non-delivery looks exactly like a success.
 */

const INVITE_PATH = '/invite/accept'

/** Where an invitation lands: the org admin registration form. */
export function inviteRedirectUrl() {
  return `${env.clientOrigins[0]}${INVITE_PATH}`
}

const supabase = {
  name: 'supabase',
  configured: () => true,

  async inviteOrgRepresentative({ email, name, organizationName }) {
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: inviteRedirectUrl(),
      // Lands in user_metadata, which the "Invite user" template reads as
      // {{ .Data.full_name }} / {{ .Data.organization_name }} - see
      // server/emails/invite-org-representative.html. full_name is also what
      // handle_new_user copies into profiles; organization_name is read by
      // nothing but the template. Neither is ever read as a permission.
      data: {
        ...(name && { full_name: name }),
        ...(organizationName && { organization_name: organizationName }),
      },
    })

    if (error) {
      // An address that already has an account cannot be re-invited; saying
      // which case it is saves the admin guessing.
      if (/already been registered|already exists/i.test(error.message)) {
        throw AppError.conflict('לכתובת הזו כבר קיים חשבון. יש להשתמש בכתובת אחרת.')
      }
      if (/rate limit|too many/i.test(error.message)) {
        throw new AppError(
          429,
          'mail_rate_limited',
          'נשלחו יותר מדי הזמנות. ספק הדוא״ל של Supabase מוגבל - יש להמתין או להגדיר SMTP.',
        )
      }
      throw new AppError(502, 'mail_failed', `שליחת ההזמנה נכשלה (${error.message}).`)
    }

    return { userId: data.user.id }
  },
}

/** The same three outcomes the supabase driver distinguishes. */
function inviteError(error) {
  if (/already been registered|already exists/i.test(error.message)) {
    return AppError.conflict('לכתובת הזו כבר קיים חשבון. יש להשתמש בכתובת אחרת.')
  }
  if (/rate limit|too many/i.test(error.message)) {
    return new AppError(429, 'mail_rate_limited', 'נשלחו יותר מדי הזמנות. יש להמתין ולנסות שוב.')
  }
  return new AppError(502, 'mail_failed', `יצירת ההזמנה נכשלה (${error.message}).`)
}

let transport = null
function smtpTransport() {
  // One pooled connection for the process, created on first use, so a
  // server without SMTP settings still boots.
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // 465 is TLS from the first byte; 587 starts plain and upgrades.
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    pool: true,
  })
  return transport
}

/**
 * Supabase creates the account and the accept link; we write and send the
 * email. That split is the point: the body is ours, per call, in Hebrew,
 * and versioned with the code - not a global template in a dashboard.
 *
 * generateLink({ type: 'invite' }) creates the user exactly as
 * inviteUserByEmail does, and returns the same verification link, without
 * sending anything. The link still goes through Supabase's /verify and lands
 * on redirectTo, so /invite/accept receives the session as before.
 */
const smtp = {
  name: 'smtp',
  configured: () => Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM),

  async inviteOrgRepresentative({ email, name, organizationName }) {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: 'invite',
      email,
      options: {
        redirectTo: inviteRedirectUrl(),
        // Same metadata the supabase driver sends, so either driver leaves
        // the account in the same state (full_name reaches profiles).
        data: {
          ...(name && { full_name: name }),
          ...(organizationName && { organization_name: organizationName }),
        },
      },
    })
    if (error) throw inviteError(error)

    const userId = data.user.id
    const message = inviteOrgRepresentativeEmail({
      name,
      organizationName,
      link: data.properties.action_link,
    })

    try {
      await smtpTransport().sendMail({ from: env.MAIL_FROM, to: email, ...message })
    } catch (sendError) {
      // The account exists but nobody was told. Left in place it would block
      // every retry with "account already exists" - so undo it, and let the
      // admin simply try again once SMTP is fixed.
      await supabaseAdmin.auth.admin.deleteUser(userId).catch((cleanupError) => {
        console.error('[mail] could not remove unsent invite user', userId, cleanupError.message)
      })
      console.error('[mail] smtp send failed:', sendError.message)
      throw new AppError(502, 'mail_failed', 'שליחת מייל ההזמנה נכשלה. בדקו את הגדרות ה-SMTP ונסו שוב.')
    }

    return { userId }
  },
}

/**
 * Not wired. Here so the shape is obvious when it is needed.
 *
 * The reason to switch: Supabase sends one global template, so every
 * invitation reads the same. Resend would mean `generateLink({ type:
 * 'invite' })` to mint the link without sending, then posting our own body -
 * which is the only way to word two invitations differently.
 */
const resend = {
  name: 'resend',
  configured: () => Boolean(env.RESEND_API_KEY && env.MAIL_FROM),
  async inviteOrgRepresentative() {
    throw new AppError(
      500,
      'mail_provider_unimplemented',
      'ספק הדוא״ל resend אינו ממומש עדיין.',
    )
  },
}

const DRIVERS = { supabase, smtp, resend }

function driver() {
  const chosen = DRIVERS[env.MAIL_PROVIDER]
  if (!chosen) {
    throw new AppError(500, 'mail_provider_unknown', `ספק דוא״ל לא מוכר: ${env.MAIL_PROVIDER}.`)
  }
  if (!chosen.configured()) {
    throw new AppError(
      500,
      'mail_provider_unconfigured',
      `ספק הדוא״ל (${chosen.name}) אינו מוגדר במלואו.`,
    )
  }
  return chosen
}

export const activeMailProvider = () => env.MAIL_PROVIDER

/**
 * Invite someone to represent their organisation on Equalmind.
 *
 * Creates the auth account and sends the invitation. It does NOT grant the
 * role - the caller does that with the id returned here, which is the whole
 * point: the grant uses an id the mail provider produced, never one named by
 * a request, so an invitation cannot be redirected onto someone else.
 */
export async function inviteOrgRepresentative({ email, name, organizationName }) {
  const active = driver()
  const { userId } = await active.inviteOrgRepresentative({ email, name, organizationName })
  return { provider: active.name, userId }
}
