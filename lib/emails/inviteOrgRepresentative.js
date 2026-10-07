/**
 * The invitation an organisation's representative receives.
 *
 * Rendered here and sent by the smtp driver in lib/mailProvider.js. (With
 * MAIL_PROVIDER=supabase, Supabase renders its dashboard template instead -
 * server/emails/invite-org-representative.html is the copy for that.)
 *
 * name and organizationName come from staff input and the database, but
 * they are still escaped: this is HTML, and an organisation name containing
 * "<" would otherwise break the email or inject markup into it.
 */

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export function inviteOrgRepresentativeEmail({ name, organizationName, link }) {
  const greeting = name ? `הי ${name},` : 'הי,'
  const appointed = organizationName
    ? `מונית/ה לנציג/ת הארגון ${organizationName} ב-Equalmind.`
    : 'מונית/ה לנציג/ת הארגון שלך ב-Equalmind.'
  const purpose = 'הזמנה זו תאפשר לך להזמין אנשים מהארגון שלך להצטרף ל-Equalmind.'

  const html = `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f4f8f5;">
  <div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;color:#0e2e1c;line-height:1.7;max-width:560px;margin:0 auto;padding:32px 24px;text-align:right;background:#ffffff;">
    <h2 style="margin:0 0 20px;font-size:22px;color:#15803d;">Equalmind</h2>
    <p style="margin:0 0 12px;font-size:16px;">${escape(greeting)}</p>
    <p style="margin:0 0 12px;font-size:16px;">${
      organizationName
        ? `מונית/ה לנציג/ת הארגון <strong>${escape(organizationName)}</strong> ב-Equalmind.`
        : escape(appointed)
    }</p>
    <p style="margin:0 0 28px;font-size:16px;">${escape(purpose)}</p>
    <p style="margin:0 0 28px;">
      <a href="${escape(link)}" style="display:inline-block;background:#15803d;color:#ffffff;text-decoration:none;font-weight:bold;font-size:16px;padding:12px 28px;border-radius:10px;">קבלת ההזמנה</a>
    </p>
    <p style="margin:0;font-size:13px;color:#64748b;">אם לא ציפית להזמנה הזו, אפשר להתעלם מהמייל.</p>
  </div>
</body>
</html>`

  // Plain-text part: some clients show only this, and spam filters score a
  // message with no text part worse.
  const text = [greeting, '', appointed, purpose, '', `לקבלת ההזמנה: ${link}`, '',
    'אם לא ציפית להזמנה הזו, אפשר להתעלם מהמייל.'].join('\n')

  return {
    subject: 'הוזמנת לייצג את הארגון שלך ב-Equalmind',
    html,
    text,
  }
}
