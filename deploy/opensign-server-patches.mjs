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

// The master key off the command line, and out of the log.
//
// On every start the server runs its migrations with `exec`, and built the command by writing the
// master key into it: `... MASTER_KEY=<the key> npx parse-dbtool migrate`. The key was then in the
// child's command line for any process on the machine to read, and when the command failed Node's
// error message is "Command failed: <the whole command>", which the next line printed: the key, in
// plain text, into the service's log, on a cold start that could not yet reach its own API.
//
// The command now names no secret. The child inherits the key from the server's own environment,
// where it already is, beside the two values it did not have. What is printed on failure is the
// exit code and the tool's own output with the key's value struck out, never the command.
const STARTUP = '/usr/src/app/index.js';
edit(STARTUP, [
  [
    "    const migrate = isWindows\n" +
      "      ? `set APPLICATION_ID=${serverAppId}&& set SERVER_URL=${cloudServerUrl}&& set MASTER_KEY=${process.env.MASTER_KEY}&& npx parse-dbtool migrate`\n" +
      "      : `APPLICATION_ID=${serverAppId} SERVER_URL=${cloudServerUrl} MASTER_KEY=${process.env.MASTER_KEY} npx parse-dbtool migrate`;\n" +
      "    exec(migrate, (error, stdout, stderr) => {\n" +
      "      if (error) {\n" +
      "        console.error(`Error: ${error.message}`);\n" +
      "        return;\n" +
      "      }\n" +
      "\n" +
      "      if (stderr) {\n" +
      "        console.error(`Error: ${stderr}`);\n" +
      "        return;\n" +
      "      }\n" +
      "      console.log(`Command output: ${stdout}`);\n" +
      "    });",
    "    const migrate = 'npx parse-dbtool migrate';\n" +
      "    const migrateEnv = { ...process.env, APPLICATION_ID: serverAppId, SERVER_URL: cloudServerUrl };\n" +
      "    const withoutSecrets = text => {\n" +
      "      let out = String(text ?? '');\n" +
      "      const named = ['MASTER_KEY', 'MONGODB_URI', 'DATABASE_URI', 'SMTP_PASS', 'PASS_PHRASE', 'PFX_BASE64', 'MAILGUN_API_KEY', 'DO_SECRET_ACCESS_KEY'];\n" +
      "      const secrets = named.map(name => process.env[name]).filter(Boolean);\n" +
      "      // A database address's own user and password, as written and as decoded.\n" +
      "      for (const uri of [process.env.MONGODB_URI, process.env.DATABASE_URI]) {\n" +
      "        const login = /^[a-z0-9+.-]+:\\/\\/([^:@\\/]+)(?::([^@\\/]*))?@/i.exec(uri || '');\n" +
      "        for (const part of [login?.[1], login?.[2]]) {\n" +
      "          if (!part) continue;\n" +
      "          secrets.push(part);\n" +
      "          try { secrets.push(decodeURIComponent(part)); } catch { /* as written only */ }\n" +
      "        }\n" +
      "      }\n" +
      "      for (const secret of secrets.sort((a, b) => b.length - a.length)) {\n" +
      "        if (secret.length >= 4) out = out.split(secret).join('[redacted]');\n" +
      "      }\n" +
      "      // Any database address at all, whatever it holds.\n" +
      "      out = out.replace(/\\b(mongodb(?:\\+srv)?:\\/\\/)[^\\s'\"]+/gi, '$1[redacted]');\n" +
      "      return out;\n" +
      "    };\n" +
      "    exec(migrate, { env: migrateEnv }, (error, stdout, stderr) => {\n" +
      "      if (error) {\n" +
      "        console.error(`Error: migrations did not run (exit ${error.code ?? 'unknown'}): ${withoutSecrets(stderr || stdout)}`);\n" +
      "        return;\n" +
      "      }\n" +
      "\n" +
      "      if (stderr) {\n" +
      "        console.error(`Error: ${withoutSecrets(stderr)}`);\n" +
      "        return;\n" +
      "      }\n" +
      "      console.log(`Command output: ${withoutSecrets(stdout)}`);\n" +
      "    });",
    'master key on the migration command line',
  ],
]);
{
  const startup = readFileSync(STARTUP, 'utf8');
  if (/MASTER_KEY=\$\{/.test(startup) || /error\.message/.test(startup.slice(startup.indexOf("npx parse-dbtool migrate")))) {
    console.error(`${STARTUP}: the master key is still written into a command, or a command is still printed`);
    process.exit(1);
  }
}

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

// A signer's refusal is mailed to the document's creator — the platform's single admin account,
// which creates every firm's documents. Where Scentic sends every message itself (the document's
// own template is only the marker, as for sendmailv3 above) Scentic tells the firm, in its own
// words, and nothing goes to the shared mailbox.
edit(`${FN}/declinedocument.js`, [
  [
    'async function sendDeclineMail(doc, publicUrl, userId, reason) {\n  try {\n',
    'async function sendDeclineMail(doc, publicUrl, userId, reason) {\n  try {\n' +
      "    if (String(doc?.RequestBody || '').includes('data-scentic-delivers')) {\n" +
      "      console.log('scentic delivers this message');\n" +
      '      return;\n' +
      '    }\n',
    'decline mail where scentic delivers',
  ],
]);
{
  const decline = readFileSync(`${FN}/declinedocument.js`, 'utf8');
  const guard = decline.indexOf("includes('data-scentic-delivers')");
  if (guard === -1 || guard > decline.indexOf('await sendSystemMail(')) {
    console.error(`${FN}/declinedocument.js: the decline mail is not held back where Scentic delivers`);
    process.exit(1);
  }
}

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

// Only the server makes accounts (the _User guard in cloud/main.js, below), so the functions that
// make a signer's or a firm user's account make it with the master key. Each is already behind its
// own check: a signed-in sender (savecontact, editcontact, the contact book), an admin (adduser), or
// a document naming the address (linkcontacttodoc).
const MASTER_SAVE = 'await _user.save(null, { useMasterKey: true });';
edit(`${FN}/linkContactToDoc.js`, [['await _user.save();', MASTER_SAVE, 'signer account']]);
edit(`${FN}/savecontact.js`, [['await _user.save();', MASTER_SAVE, 'contact account']]);
edit(`${FN}/editContact.js`, [['await _user.save();', MASTER_SAVE, 'edited contact account']]);
edit(`${FN}/ContactBookAftersave.js`, [['await _user.save();', MASTER_SAVE, 'contact book account']]);
edit(`${FN}/addUser.js`, [['await _user.save();', MASTER_SAVE, 'firm user account']]);

// usersignup and addadmin are open to anyone and, given an address that already has an account,
// sign in as it (/loginAs with the master key) and hand back its session, whatever password was
// sent: with addadmin anyone could become any signer by naming their address (usersignup does the
// same once upstream's undefined normalizeEmail is fixed). Both are for the server alone now; the
// gateway makes the first admin with the master key (gateway/src/opensign/opensign-client.ts
// createFirstAdmin).
const SERVER_ONLY =
  "  if (!request.master) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Accounts are not open for sign-up.');\n";
edit(`${FN}/usersignup.js`, [
  [
    'export default async function usersignup(request) {\n',
    `export default async function usersignup(request) {\n${SERVER_ONLY}`,
    'usersignup for the server',
  ],
  ['await user.signUp();', 'await user.signUp(null, { useMasterKey: true });', 'usersignup account'],
]);
edit(`${FN}/AddAdmin.js`, [
  [
    'export default async function AddAdmin(request) {\n',
    `export default async function AddAdmin(request) {\n${SERVER_ONLY}`,
    'addadmin for the server',
  ],
  ['await user.signUp();', 'await user.signUp(null, { useMasterKey: true });', 'addadmin account'],
]);

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
      '// Scentic: accounts are made by the server, never by whoever asks. An open sign-up let anyone\n' +
      '// register an address before a sender named it as a signer; the document would then let that\n' +
      '// account in, because a signer is linked to whatever account already holds their address.\n' +
      'Parse.Cloud.beforeSave(Parse.User, request => {\n' +
      "  if (!request.master && !request.original) throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Accounts are not open for sign-up.');\n" +
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
