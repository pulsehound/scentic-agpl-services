// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scentic's SendMailOTPv1 — the code a signer enters before a document opens. Replaces OpenSign's
// cloud/parsefunction/SendMailOTPv1.js at image build (deploy/opensign-server-patches.mjs).
//
// What changed from upstream, and why:
// - Six digits from a cryptographic source, not four from Math.random: four digits is 9,000 guesses.
// - A code expires ten minutes after it is sent, and AuthLoginAsMail lets it be used once and tried
//   five times (see that file). Upstream codes lived until the next one was asked for.
// - Codes go only to somebody asked to sign the document named in the request. Upstream mailed a
//   code to any address for any caller — which, with a document's id in every signing link, let a
//   replaced signer go on opening the document with a code to their own address.
// - At most five codes an hour to one address, and none within half a minute of the last: a page
//   that anyone can load must not be a way to flood somebody's inbox, or to multiply guesses.
// - The email is Scentic's: plain, the same layout as every other signing email
//   (apps/web/src/lib/signature-mail/layout.ts in the Scentic repository), with a text twin.
import { randomInt } from 'node:crypto';
import { appName, smtpenable, updateMailCount } from '../../Utils.js';

export const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 30 * 1000;
const SENDS_PER_HOUR = 5;

const normalise = value => String(value || '').toLowerCase().replace(/\s/g, '');

async function documentFor(docId) {
  const query = new Parse.Query('contracts_Document');
  query.equalTo('objectId', docId);
  query.notEqualTo('IsArchive', true);
  return query.first({ useMasterKey: true });
}

const isAskedToSign = (doc, email) =>
  (doc?.get('Placeholders') || []).some(p => normalise(p?.email) === email && p?.Role !== 'prefill');

// ── The email ────────────────────────────────────────────────────────────────

const BRAND = {
  navy: '#1f2a44',
  ink: '#1b1f27',
  muted: '#5b6472',
  hairline: '#e3e6eb',
  surface: '#ffffff',
  ground: '#f3f4f6',
  noteGround: '#f6f7f9',
  font: "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', Arial, sans-serif",
};

const esc = value =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The code email. Exported for the build check in opensign-server-patches.mjs. */
export function codeMail({ code, documentName, senderName, firmName }) {
  const title = documentName || 'the document';
  // The sender's name and the firm's, once each: a request sent in the firm's name carries it twice.
  const from = [...new Map([senderName, firmName].filter(Boolean).map(n => [n.trim().toLowerCase(), n.trim()])).values()].join(', ');
  const heading = 'Your signing code';
  const lead = documentName
    ? `Enter this code on the signing page to open <strong style="color:${BRAND.ink};font-weight:600">${esc(title)}</strong>.`
    : 'Enter this code on the signing page to open the document.';
  const footer = [
    'You’re receiving this because the signing link sent to this address was opened. If that wasn’t you, ignore this email: without the code the document stays closed.',
    'Don’t share this code with anyone.',
  ];
  const p = inner =>
    `<p style="margin:0 0 16px;font-family:${BRAND.font};font-size:15px;line-height:24px;color:${BRAND.ink}">${inner}</p>`;

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${heading}</title></head>` +
    `<body style="margin:0;padding:0;background:${BRAND.ground}">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Enter it on the signing page. It works once, for 10 minutes.</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.ground}" style="background:${BRAND.ground}"><tr><td align="center" style="padding:32px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">` +
    `<tr><td align="left" style="padding:0 4px 18px">` +
    `<p style="margin:0;font-family:${BRAND.font};font-size:18px;line-height:22px;letter-spacing:7px;font-weight:300;color:${BRAND.navy}">SCENTIC</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 10px"><tr><td width="38" height="1" bgcolor="${BRAND.navy}" style="width:38px;height:1px;line-height:1px;font-size:0;background:${BRAND.navy}">&nbsp;</td></tr></table>` +
    (firmName
      ? `<p dir="auto" style="margin:0;font-family:${BRAND.font};font-size:12px;line-height:16px;letter-spacing:1px;text-transform:uppercase;color:${BRAND.muted}">${esc(firmName)}</p>`
      : '') +
    `</td></tr>` +
    `<tr><td bgcolor="${BRAND.surface}" style="background:${BRAND.surface};border:1px solid ${BRAND.hairline};border-radius:10px;padding:32px 32px 28px">` +
    `<h1 style="margin:0 0 16px;font-family:${BRAND.font};font-size:21px;line-height:28px;font-weight:600;color:${BRAND.ink}">${heading}</h1>` +
    p(lead) +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px"><tr>` +
    `<td style="padding:14px 22px;background:${BRAND.noteGround};border:1px solid ${BRAND.hairline};border-radius:8px">` +
    `<p style="margin:0;font-family:Consolas,'SFMono-Regular',Menlo,monospace;font-size:30px;line-height:36px;letter-spacing:8px;font-weight:600;color:${BRAND.navy}">${code}</p>` +
    `</td></tr></table>` +
    p('It works once, for 10 minutes. If it expires, ask the signing page for a new one.') +
    (from
      ? `<p style="margin:0;font-family:${BRAND.font};font-size:13px;line-height:20px;color:${BRAND.muted}">Sent for <span dir="auto" style="color:${BRAND.ink}">${esc(from)}</span></p>`
      : '') +
    `</td></tr>` +
    `<tr><td style="padding:18px 8px 0">` +
    footer.map(line => `<p style="margin:0 0 8px;font-family:${BRAND.font};font-size:12px;line-height:18px;color:${BRAND.muted}">${esc(line)}</p>`).join('') +
    `<p style="margin:12px 0 0;font-family:${BRAND.font};font-size:11px;line-height:16px;letter-spacing:1px;text-transform:uppercase;color:#8a919c">Scentic · secure electronic signature</p>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = [
    ...(firmName ? [firmName, ''] : []),
    heading,
    '',
    documentName ? `Enter this code on the signing page to open ${documentName}:` : 'Enter this code on the signing page to open the document:',
    '',
    `    ${code}`,
    '',
    'It works once, for 10 minutes. If it expires, ask the signing page for a new one.',
    ...(from ? ['', `Sent for ${from}`] : []),
    '',
    '—',
    ...footer,
    'Scentic · secure electronic signature',
  ].join('\n');

  return { subject: documentName ? `Your signing code for ${documentName}` : 'Your signing code', html, text };
}

// ── The function ─────────────────────────────────────────────────────────────

async function sendMailOTPv1(request) {
  const email = normalise(request.params.email);
  if (!email) return 'Please Enter valid email';
  const docId = request.params?.docId;

  let doc;
  if (docId) {
    doc = await documentFor(docId);
    if (!doc || !isAskedToSign(doc, email)) {
      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This signing link is no longer active.');
    }
  } else if (!request.master && normalise(request.user?.get('email')) !== email) {
    // Without a document, only for the signed-in account's own address (OpenSign's profile page).
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'A code can only be sent to your own address.');
  }

  const now = Date.now();
  const existing = await new Parse.Query('defaultdata_Otp').equalTo('Email', email).first({ useMasterKey: true });
  const lastSent = existing?.get('SentAt')?.getTime?.() ?? 0;
  const live = existing?.get('OTP') != null && (existing?.get('ExpiresAt')?.getTime?.() ?? 0) > now;
  if (live && now - lastSent < RESEND_AFTER_MS) {
    // Asked twice in a row: the code just sent still works.
    return 'Otp send';
  }
  const windowStart = existing?.get('WindowStart')?.getTime?.() ?? 0;
  const inWindow = now - windowStart < 60 * 60 * 1000;
  const sends = inWindow ? existing?.get('Sends') || 0 : 0;
  if (sends >= SENDS_PER_HOUR) {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Too many codes were sent to this address. Try again in an hour.');
  }

  const code = randomInt(100000, 1000000);
  const row = existing || new (Parse.Object.extend('defaultdata_Otp'))();
  row.set('Email', email);
  row.set('OTP', code);
  row.set('ExpiresAt', new Date(now + CODE_TTL_MS));
  row.set('SentAt', new Date(now));
  row.set('Attempts', 0);
  row.set('Sends', sends + 1);
  row.set('WindowStart', inWindow ? existing.get('WindowStart') : new Date(now));
  if (!existing && request.params.TenantId) row.set('TenantId', request.params.TenantId);
  await row.save(null, { useMasterKey: true });

  const mail = codeMail({
    code,
    documentName: doc?.get('Name') || '',
    senderName: doc?.get('SenderName') || '',
    firmName: doc?.get('FirmName') || '',
  });
  const mailsender = smtpenable ? process.env.SMTP_USER_EMAIL : process.env.MAILGUN_SENDER;
  try {
    await Parse.Cloud.sendEmail({
      sender: appName + ' <' + mailsender + '>',
      recipient: email,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    // Never the code itself: logs are read by more people than inboxes are.
    console.log('signing code sent');
    const extUserId = doc?.get('ExtUserPtr')?.id;
    if (extUserId) updateMailCount(extUserId);
  } catch (err) {
    console.log('error in send OTP mail', err?.message || err);
    throw new Parse.Error(Parse.Error.EMAIL_NOT_FOUND, 'The code could not be sent. Try again in a minute.');
  }
  return 'Otp send';
}
export default sendMailOTPv1;
