// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edits to OpenSign's server, applied at image build (deploy/Dockerfile.opensign-server).
// Each edit names the exact text it replaces and fails the build if that text is not there, so a
// change upstream surfaces here rather than as a silently unpatched image.
import { readFileSync, writeFileSync } from 'node:fs';

function edit(file, edits) {
  let text = readFileSync(file, 'utf8');
  for (const [from, to, why] of edits) {
    if (!text.includes(from)) {
      console.error(`${file}: not found (${why})`);
      process.exit(1);
    }
    text = text.split(from).join(to);
  }
  writeFileSync(file, text);
}

const PDF = '/usr/src/app/cloud/parsefunction/pdf/PDF.js';
edit(PDF, [
  [
    // The completed document went to the signers and to the document's owner — the platform's
    // single admin account, which owns every firm's documents. One firm's executed agreements
    // must not land in a shared mailbox; Scentic tells the firm itself.
    ': [...doc?.Signers?.map(x => x?.Email), sender.Email]?.join(\',\');',
    ': doc?.Signers?.map(x => x?.Email)?.join(\',\');',
    'completion mail recipients',
  ],
  [
    'let subject = `Document "${pdfName}" has been signed by all parties`;',
    'let subject = `Signed: ${pdfName}`;',
    'completion mail subject',
  ],
  [
    // A third party's logo, a teal banner and an "automated email" footer, around one sentence.
    "    \"<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8' /></head><body><div style='background-color:#f5f5f5;padding:20px'><div style='background-color:white'>\" +\n" +
      "    `<div>${logo}</div><div style='padding:2px;font-family:system-ui;background-color:#47a3ad'><p style='font-size:20px;font-weight:400;color:white;padding-left:20px'>Document signed successfully</p></div><div>` +\n" +
      "    `<p style='padding:20px;font-family:system-ui;font-size:14px'>All parties have successfully signed the document <b>\"${pdfName}\"</b>. Kindly download the document from the attachment.</p>` +\n" +
      "    `</div></div><div><p>This is an automated email from ${TenantAppName}. For any queries regarding this email, please contact the sender ${sender.Email} directly.</p></div></div></body></html>`;",
    "    \"<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8' /></head><body>\" +\n" +
      "    `<div style='font-family:Segoe UI,Arial,sans-serif;color:#1f2329;max-width:560px;margin:0 auto'>` +\n" +
      "    `<p style='margin:0 0 20px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#5f6368'>${doc?.SenderName || ''}</p>` +\n" +
      "    `<p style='margin:0 0 12px'>Everyone has signed <strong>${pdfName}</strong>.</p>` +\n" +
      "    `<p style='margin:0'>The signed copy is attached.</p></div></body></html>`;",
    'completion mail body',
  ],
  [
    // The name and contact written into every signature on a signed PDF ("Digitally signed by …"),
    // which a reader sees in their PDF viewer's signature panel.
    "const eSignName = 'OpenSign';",
    "const eSignName = process.env.ESIGN_NAME || 'Scentic';",
    'signature name',
  ],
  [
    "const eSigncontact = 'hello@opensignlabs.com';",
    "const eSigncontact = process.env.ESIGN_CONTACT || 'esign@scentic.com';",
    'signature contact',
  ],
  [
    // The completed document reaches signers from Scentic, which attaches it when it can and sends
    // a link when it cannot. OpenSign could only attach, and its mail server refuses anything over
    // 10 MB, so a signer of a long agreement received nothing. Off unless SEND_COMPLETION_MAIL=true.
    '  if (doc.IsSendMail === false) {\n    console.log("don\'t send mail");',
    '  if (doc.IsSendMail === false || process.env.SEND_COMPLETION_MAIL !== \'true\') {\n    console.log("don\'t send mail");',
    'completion mail off',
  ],
]);

const SENDMAIL = '/usr/src/app/cloud/parsefunction/sendMailv3.js';
edit(SENDMAIL, [
  [
    // In a document signed in order, the signer's browser asks for the next signer to be mailed
    // straight after signing, from the document's template. Where Scentic sends every message
    // itself, that template is only a marker (gateway SCENTIC_DELIVERS_TEMPLATE): answered as sent,
    // and nothing leaves. Scentic invites the next signer, in its own words, when it learns the
    // previous one signed.
    'async function sendmailv3(req) {\n  const nonCustomMail = await sendMailProvider(req);',
    "async function sendmailv3(req) {\n  if (String(req.params?.html || '').includes('data-scentic-delivers')) {\n    console.log('scentic delivers this message');\n    return { status: 'success' };\n  }\n  const nonCustomMail = await sendMailProvider(req);",
    'scentic delivers',
  ],
]);

const INDEX = '/usr/src/app/index.js';
edit(INDEX, [
  // Bodies were capped at 100 MB — a signed PDF is posted back base64 by the signer's browser, so
  // about 75 MB of document. Set by MAX_BODY_SIZE; the service runs HTTP/2 end to end, where the
  // platform imposes no ceiling of its own.
  ["maxUploadSize: '100mb',", "maxUploadSize: process.env.MAX_BODY_SIZE || '1gb',", 'parse upload size'],
  ["app.use(express.json({ limit: '100mb' }));", "app.use(express.json({ limit: process.env.MAX_BODY_SIZE || '1gb' }));", 'json limit'],
  [
    "app.use(express.urlencoded({ limit: '100mb', extended: true }));",
    "app.use(express.urlencoded({ limit: process.env.MAX_BODY_SIZE || '1gb', extended: true }));",
    'urlencoded limit',
  ],
]);

// ── Who can open a document ─────────────────────────────────────────────────────────────────────
//
// Upstream hands a whole document to anyone who asks with its id unless the document has email
// codes on (IsEnableOTP), and the id is in every signing link. So a signer who was replaced, or who
// handed over, could still open the document read-only, and so could anyone a past invitation was
// forwarded to. Here a document opens only for the server's own calls (the master key: the gateway)
// and for a signed-in account its ACL names; signers sign in with a code emailed to them, which
// goes only to people still asked to sign; and signing and declining are bound to that account.
// The gateway turns codes on for every request and takes a replaced signer off the ACL.

const FN = '/usr/src/app/cloud/parsefunction';
const FILES = '/tmp/opensign-server-files';

/** Swap an upstream file for ours, after checking upstream still has the shape ours replaces. */
function replace(file, source, markers) {
  const text = readFileSync(file, 'utf8');
  for (const marker of markers) {
    if (!text.includes(marker)) {
      console.error(`${file}: upstream changed shape (${marker})`);
      process.exit(1);
    }
  }
  writeFileSync(file, readFileSync(source, 'utf8'));
}

replace(`${FN}/SendMailOTPv1.js`, `${FILES}/SendMailOTPv1.js`, [
  'Math.floor(1000 + Math.random() * 9000)',
  "new Parse.Query('defaultdata_Otp')",
  'export default sendMailOTPv1;',
]);
replace(`${FN}/AuthLoginAsMail.js`, `${FILES}/AuthLoginAsMail.js`, [
  "checkOtp.equalTo('Email', email);",
  '/loginAs',
  'export default AuthLoginAsMail;',
]);

edit(`${FN}/getDocument.js`, [
  [
    '          if (!IsEnableOTP) {\n            return document;\n          } else {',
    '          // Scentic: never for the id alone, whatever IsEnableOTP says — for the gateway (master\n' +
      '          // key), or for a signed-in account the ACL names (below).\n' +
      '          if (request.master) {\n            return document;\n          } else {',
    'getDocument without a session',
  ],
]);

edit(PDF, [
  [
    "    const IsEnableOTP = resDoc?.get('IsEnableOTP') || false;\n" +
      '    // if `IsEnableOTP` is false then we don\'t have to check authentication\n' +
      '    if (IsEnableOTP) {\n' +
      '      if (!req?.user) {\n' +
      "        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');\n" +
      '      }\n' +
      '    }',
    '    // Scentic: a signature is made by a signed-in account, as the signer that account is.\n' +
      '    if (!req?.master) {\n' +
      '      if (!req?.user) {\n' +
      "        throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');\n" +
      '      }\n' +
      '      const signerAccount = reqUserId\n' +
      "        ? (resDoc.get('Signers') || []).find(x => x?.id === reqUserId)?.get('UserId')?.id\n" +
      "        : resDoc.get('ExtUserPtr')?.get('UserId')?.id;\n" +
      '      if (!signerAccount || signerAccount !== req.user.id) {\n' +
      "        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'You are not asked to sign this document.');\n" +
      '      }\n' +
      '    }',
    'signPdf without a session',
  ],
]);

edit(`${FN}/declinedocument.js`, [
  ['      if (!isEnableOTP) {', '      if (request.master) {', 'declinedoc without a session'],
  [
    '        if (!request?.user) {\n' +
      "          throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');\n" +
      '        }\n',
    '        if (!request?.user) {\n' +
      "          throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'User is not authenticated.');\n" +
      '        }\n' +
      '        // Scentic: only for yourself, on a document you can open.\n' +
      '        if (request.user.id !== userId || !updateDoc.getACL()?.getReadAccess(request.user.id)) {\n' +
      "          throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'You are not asked to sign this document.');\n" +
      '        }\n',
    'declinedoc for somebody else',
  ],
]);

edit(`${FN}/getSignedUrl.js`, [
  [
    '    if (docId || templateId) {\n      try {\n',
    '    if (docId || templateId) {\n      try {\n' +
      "        // Scentic: a document's files are signed for the gateway and for accounts that can open it.\n" +
      '        if (docId && !request.master) {\n' +
      "          const owner = await new Parse.Query('contracts_Document').get(docId, { useMasterKey: true }).catch(() => null);\n" +
      '          if (!owner || !request?.user || !owner.getACL()?.getReadAccess(request.user.id)) {\n' +
      "            throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, \"You don't have access of this document!\");\n" +
      '          }\n' +
      '        }\n',
    'getsignedurl without access',
  ],
]);

edit(`${FN}/VerifyEmail.js`, [
  [
    '      let email = request.params.email;\n',
    '      let email = request.params.email;\n' +
      "      // Scentic: a code proves only the signed-in account's own address.\n" +
      "      if (String(email || '').toLowerCase().replace(/\\s/g, '') !== String(request.user.get('email') || '').toLowerCase()) {\n" +
      "        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'A code can only verify your own address.');\n" +
      '      }\n',
    'verifyemail for another address',
  ],
]);

// Upstream gives every signer's account the password of their own email address. Anyone who knew a
// signer's address could sign in as them with it and read every document they are on — the codes
// would protect nothing. New accounts get a random password nobody knows (signers sign in only with
// a code), and password sign-in is refused to signers' accounts made before this (cloud/main.js).
const RANDOM_PASSWORD = "(await import('node:crypto')).randomBytes(32).toString('hex')";
edit(`${FN}/linkContactToDoc.js`, [["_user.set('password', email);", `_user.set('password', ${RANDOM_PASSWORD});`, 'signer password']]);
edit(`${FN}/savecontact.js`, [["_user.set('password', email);", `_user.set('password', ${RANDOM_PASSWORD});`, 'contact password']]);
edit(`${FN}/editContact.js`, [
  ["_user.set('password', email?.toLowerCase()?.replace(/\\s/g, ''));", `_user.set('password', ${RANDOM_PASSWORD});`, 'edited contact password'],
]);
edit(`${FN}/ContactBookAftersave.js`, [["_user.set('password', Email);", `_user.set('password', ${RANDOM_PASSWORD});`, 'contact book password']]);

edit('/usr/src/app/cloud/main.js', [
  [
    "Parse.Cloud.define('createdocumentfromapp', createDocumentFromApp);",
    "Parse.Cloud.define('createdocumentfromapp', createDocumentFromApp);\n" +
      '\n' +
      '// Scentic: password sign-in is for the platform\'s own accounts. A signer\'s account (a contact,\n' +
      '// with no contracts_Users row) signs in only with a code emailed to it, through /loginAs, which\n' +
      '// runs no login hooks. Accounts made before passwords were randomised have their email as password.\n' +
      'Parse.Cloud.beforeLogin(async request => {\n' +
      "  const isPlatform = await new Parse.Query('contracts_Users').equalTo('UserId', request.object).first({ useMasterKey: true });\n" +
      '  if (isPlatform) return;\n' +
      "  const isContact = await new Parse.Query('contracts_Contactbook').equalTo('UserId', request.object).first({ useMasterKey: true });\n" +
      "  if (isContact) throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Invalid username/password.');\n" +
      '});\n' +
      '\n' +
      '// Scentic: nobody reads documents anonymously, by id, by query or by count.\n' +
      "Parse.Cloud.beforeFind('contracts_Document', request => {\n" +
      "  if (!request.master && !request.user) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Sign in to open this document.');\n" +
      '});',
    'login and anonymous-read guards',
  ],
]);

console.log('opensign server patched');
