// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edits to OpenSign's server, applied at image build (deploy/Dockerfile.opensign-server).
// Each edit names the exact text it replaces and fails the build if that text is not there, so a
// change upstream surfaces here rather than as a silently unpatched image. Run a second time over
// files already patched, it fails too, naming the edit that is already there: nothing is ever
// applied twice.
//
// At image build this file is run as a script (`node opensign-server-patches.mjs`) and patches
// /usr/src/app. Imported, it does nothing until applyServerPatches is called with another root,
// which is how deploy/tests runs every edit over the vendored upstream source.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const count = (text, part) => (part === '' ? 0 : text.split(part).length - 1);

/**
 * Apply every edit under `root` (the server's /usr/src/app), taking replacement files from
 * `filesDir` (deploy/opensign-server-files). Throws on the first edit that does not apply.
 * Returns { applied: [{ file, why, count }], refused: [message] } with paths relative to `root`.
 *
 * `keepGoing` is for tests: an edit that does not apply is recorded in `refused` and the rest are
 * still tried, so one run says what every edit would do. The image build never sets it.
 */
export function applyServerPatches({ root = '/usr/src/app', filesDir = '/tmp/opensign-server-files', keepGoing = false } = {}) {
  const applied = [];
  const refused = [];
  const relative = file => file.slice(root.length + 1);
  const refuse = message => {
    if (!keepGoing) throw new Error(message);
    refused.push(message);
  };

  function edit(file, edits) {
    let text = readFileSync(file, 'utf8');
    for (const [from, to, why] of edits) {
      const found = count(text, from);
      // Already there: every place the old text appears is inside the new text, or the old text is
      // gone and the new text is present.
      const already = to.includes(from)
        ? count(text, to) > 0 && found === count(text, to) * count(to, from)
        : found === 0 && text.includes(to);
      if (already) {
        refuse(`${file}: already patched (${why})`);
        continue;
      }
      if (found === 0) {
        refuse(`${file}: not found (${why})`);
        continue;
      }
      text = text.split(from).join(to);
      applied.push({ file: relative(file), why, count: found });
    }
    writeFileSync(file, text);
  }

  const PDF = `${root}/cloud/parsefunction/pdf/PDF.js`;
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
      //
      // And never for a document Scentic delivers every message of (its template is the marker, as
      // for sendmailv3 and the decline notice below), whatever that setting says. This is the one
      // mail OpenSign addresses to the document's SenderMail (a blind copy of the completed
      // document), and the gateway now writes the sender's own address there for the certificate
      // to print: an address put on a document to be printed must not start receiving mail.
      '  if (doc.IsSendMail === false) {\n    console.log("don\'t send mail");',
      '  if (doc.IsSendMail === false || process.env.SEND_COMPLETION_MAIL !== \'true\' || String(doc?.RequestBody || \'\').includes(\'data-scentic-delivers\')) {\n    console.log("don\'t send mail");',
      'completion mail off',
    ],
  ]);
  {
    // The completion mail is sent from one place, and that place is behind the check above.
    const pdf = readFileSync(PDF, 'utf8');
    const guard = pdf.indexOf("|| String(doc?.RequestBody || '').includes('data-scentic-delivers')) {");
    const call = pdf.indexOf('sendCompletedMail({');
    if (guard === -1 || call === -1 || guard > call || count(pdf, 'sendCompletedMail({') !== 1) {
      throw new Error(`${PDF}: the completion mail is not held back where Scentic delivers`);
    }
  }

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
  const STARTUP = `${root}/index.js`;
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
      throw new Error(`${STARTUP}: the master key is still written into a command, or a command is still printed`);
    }
  }

  const SENDMAIL = `${root}/cloud/parsefunction/sendMailv3.js`;
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

  const INDEX = `${root}/index.js`;
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

  const FN = `${root}/cloud/parsefunction`;
  const FILES = filesDir;

  /** Swap an upstream file for ours, after checking upstream still has the shape ours replaces. */
  function replace(file, source, markers) {
    const text = readFileSync(file, 'utf8');
    for (const marker of markers) {
      if (!text.includes(marker)) {
        // Ours already, or upstream's no longer the file ours was written to replace.
        refuse(`${file}: ${text === readFileSync(source, 'utf8') ? 'already patched (replaced)' : `upstream changed shape (${marker})`}`);
        return;
      }
    }
    writeFileSync(file, readFileSync(source, 'utf8'));
    applied.push({ file: relative(file), why: 'replaced', count: 1 });
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
      throw new Error(`${FN}/declinedocument.js: the decline mail is not held back where Scentic delivers`);
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

  edit(`${root}/cloud/main.js`, [
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

  // ── The completion certificate ────────────────────────────────────────────────────────────────
  //
  // Where Scentic hosts the signing ceremony, its own record of it (the document's ScenticAudit:
  // every link opened, code verified, view, signature and refusal, with time, address and browser)
  // is printed on the certificate after the signers, as "Event history". The drawing is ours
  // (opensign-server-files/scenticEventHistory.js), added beside the generator; the generator gains
  // an import and one call, after the last signer and before the PDF is saved. A document with no
  // ScenticAudit gets the certificate it got before.

  /** Add a file of ours where upstream has none. */
  function add(file, source) {
    if (existsSync(file)) {
      refuse(`${file}: ${readFileSync(file, 'utf8') === readFileSync(source, 'utf8') ? 'already patched (added)' : 'upstream now has a file of this name'}`);
      return;
    }
    writeFileSync(file, readFileSync(source, 'utf8'));
    applied.push({ file: relative(file), why: 'added', count: 1 });
  }

  add(`${FN}/pdf/scenticEventHistory.js`, `${FILES}/scenticEventHistory.js`);
  edit(`${FN}/pdf/GenerateCertificate.js`, [
    [
      "import { formatDateTime } from '../../../Utils.js';\n",
      "import { formatDateTime } from '../../../Utils.js';\n" +
        "import { drawScenticEventHistory, drawScenticRelatedDocuments, scenticLine, scenticOrganization, scenticReadingOrder, scenticSignerName } from './scenticEventHistory.js';\n",
      'certificate event history import',
    ],
    // Right-to-left text (a Hebrew name, title or firm) drawn so that it reads right to left and is
    // copied, searched and extracted in the order it was typed (F-19): the certificate's one font
    // writes such text glyph by glyph in visual order, whatever pdf-lib's shaper would have done
    // with it (scenticReadingOrder). Every string drawn with it stays in the order it was typed.
    [
      '  const timesRomanFont = await pdfDoc.embedFont(fontBytes, { subset: true });\n',
      '  const timesRomanFont = scenticReadingOrder(await pdfDoc.embedFont(fontBytes, { subset: true }));\n',
      'certificate font in reading order',
    ],
    [
      '    yPosition8 = yPosition8 - 174;\n  }\n\n  const pdfBytes = await pdfDoc.save();\n  return pdfBytes;\n',
      '    yPosition8 = yPosition8 - 174;\n  }\n\n' +
        "  // Scentic: its own record of the ceremony, after the signers. Never the reason a certificate\n" +
        '  // is not made: a record that cannot be drawn is left off and said so in the log.\n' +
        '  try {\n' +
        '    drawScenticEventHistory({\n' +
        '      pdfDoc,\n' +
        '      font: timesRomanFont,\n' +
        '      events: docDetails?.ScenticAudit,\n' +
        '      names: docDetails?.ScenticSignerNames,\n' +
        '      page: currentPage,\n' +
        '      y: yPosition1,\n' +
        '      startX,\n' +
        '      startY,\n' +
        '      borderColor,\n' +
        '      titleColor,\n' +
        '    });\n' +
        '  } catch (err) {\n' +
        "    console.log('event history left off the certificate:', err?.message);\n" +
        '  }\n\n' +
        '  const pdfBytes = await pdfDoc.save();\n  return pdfBytes;\n',
      'certificate event history',
    ],
  ]);

  // The name in each signer's block. OpenSign prints the contact's name, and keeps one contact per
  // email address for the whole platform: the name on one firm's certificate was whatever the first
  // firm ever to write to that address had called them. The signer confirms their own name when
  // they sign (the document's ScenticSignerNames, written by the gateway); that is what is printed,
  // and the contact's name only where a document has none.
  edit(`${FN}/pdf/GenerateCertificate.js`, [
    [
      '          return {\n            ...data,\n            ipAddress: x.ipAddress,\n',
      '          return {\n            ...data,\n' +
        '            Name: scenticSignerName(docDetails, data?.Email, data?.Name, timesRomanFont),\n' +
        '            ipAddress: x.ipAddress,\n',
      'certificate signer name',
    ],
  ]);
  // Only the people who sign it now. When a signer is replaced or passes the request on, OpenSign
  // keeps the view the earlier person left in AuditTrail, and drops them from Signers: upstream then
  // printed them as a signer with no name and no address, "signed" at the moment the certificate was
  // made (SignedOn falls back to the generation time). Seen on staging, round 76. An entry of
  // someone no longer among the document's signers is left out of the signers' blocks; Scentic's
  // own event history still says who passed it on, when and why.
  edit(`${FN}/pdf/GenerateCertificate.js`, [
    [
      '  const filteredaudit = docDetails?.AuditTrail?.filter(x => {\n    if (!x?.UserPtr?.objectId) return false;\n    return true;\n  });\n',
      '  const filteredaudit = docDetails?.AuditTrail?.filter(x => {\n    if (!x?.UserPtr?.objectId) return false;\n' +
        '    if (Array.isArray(docDetails?.Signers) && docDetails.Signers.length > 0 && !docDetails.Signers.some(y => y?.objectId === x.UserPtr.objectId)) return false;\n' +
        '    return true;\n  });\n',
      'certificate signers: only those who sign it now',
    ],
  ]);
  // "Organization". OpenSign prints the company of the account that owns the document, and one
  // platform account owns every firm's documents: every firm's certificate said "Scentic". The
  // gateway writes the sending firm's name on the document when it creates it (ScenticFirmName;
  // FirmName on documents made before that); that is what is printed, and the account's company
  // only for a document that names no firm.
  edit(`${FN}/pdf/GenerateCertificate.js`, [
    [
      "  const company = docDetails?.ExtUserPtr?.Company || '';\n",
      "  const company = scenticOrganization(docDetails, docDetails?.ExtUserPtr?.Company || '', timesRomanFont, width - 30 - 110);\n",
      'certificate organization',
    ],
  ]);

  // The originator's name and address. Upstream draws both as they are stored, whatever their
  // length; the address is now the sender's own (the document's SenderMail, written by the
  // gateway) and the name the firm's own wording. Each is made drawable and kept inside the border.
  edit(`${FN}/pdf/GenerateCertificate.js`, [
    [
      "  const ownerName = docDetails?.SenderName || docDetails.ExtUserPtr?.Name || 'n/a';\n" +
        "  const ownerEmail = docDetails?.SenderMail || docDetails.ExtUserPtr?.Email || 'n/a';\n",
      "  const ownerName = scenticLine(timesRomanFont, docDetails?.SenderName || docDetails.ExtUserPtr?.Name || 'n/a', 13, width - 30 - 105);\n" +
        "  const ownerEmail = scenticLine(timesRomanFont, docDetails?.SenderMail || docDetails.ExtUserPtr?.Email || 'n/a', 13, width - 30 - 105);\n",
      'certificate originator name and address',
    ],
  ]);

  // "Documents in this request": where several documents were sent to be signed together, each
  // one's certificate lists them all (the document's ScenticRelatedDocuments, written by the
  // gateway), between the summary and the originator. The list can be any length, so what follows
  // it can no longer sit at a fixed height on the first page: the originator block's four heights
  // and the page it is drawn on become variables, set to where the list ended. The signers'
  // blocks already follow from there. A document with no list is drawn exactly as before.
  edit(`${FN}/pdf/GenerateCertificate.js`, [
    [
      '  const page = pdfDoc.addPage();\n  const { width, height } = page.getSize();\n',
      '  let page = pdfDoc.addPage();\n  const { width, height } = page.getSize();\n',
      'certificate page can move on',
    ],
    [
      '  const originatorHeaderY = signersY - 20;\n  const nameY = originatorHeaderY - 17;\n  const emailY = nameY - 20;\n  const ipY = emailY - 20;\n',
      '  let originatorHeaderY = signersY - 20;\n  let nameY = originatorHeaderY - 17;\n  let emailY = nameY - 20;\n  let ipY = emailY - 20;\n',
      'certificate originator can move down',
    ],
    [
      "  page.drawText('Document originator', {\n",
      "  // Scentic: the documents sent together in this request, after the summary. Never the reason a\n" +
        '  // certificate is not made: a list that cannot be drawn is left off and said so in the log.\n' +
        '  try {\n' +
        '    const related = drawScenticRelatedDocuments({\n' +
        '      pdfDoc,\n' +
        '      font: timesRomanFont,\n' +
        '      documents: docDetails?.ScenticRelatedDocuments,\n' +
        '      page,\n' +
        '      y: originatorHeaderY,\n' +
        '      startX,\n' +
        '      startY,\n' +
        '      borderColor,\n' +
        '      titleColor,\n' +
        '    });\n' +
        '    if (related) {\n' +
        '      page = related.page;\n' +
        '      originatorHeaderY = related.y;\n' +
        '      nameY = originatorHeaderY - 17;\n' +
        '      emailY = nameY - 20;\n' +
        '      ipY = emailY - 20;\n' +
        '    }\n' +
        '  } catch (err) {\n' +
        "    console.log('documents in this request left off the certificate:', err?.message);\n" +
        '  }\n\n' +
        "  page.drawText('Document originator', {\n",
      'certificate related documents',
    ],
  ]);
  {
    // What the three changes above are for, checked in the file as it now is.
    const certificate = readFileSync(`${FN}/pdf/GenerateCertificate.js`, 'utf8');
    const organization = certificate.indexOf("page.drawText('Organization :'");
    const related = certificate.indexOf('drawScenticRelatedDocuments({');
    const originator = certificate.indexOf("page.drawText('Document originator'");
    if (certificate.includes("const company = docDetails?.ExtUserPtr?.Company || '';") || count(certificate, 'scenticOrganization(docDetails,') !== 1) {
      throw new Error(`${FN}/pdf/GenerateCertificate.js: the certificate's organization is not the sending firm's name`);
    }
    if (organization === -1 || related === -1 || originator === -1 || !(organization < related && related < originator)) {
      throw new Error(`${FN}/pdf/GenerateCertificate.js: the documents in a request are not listed between the summary and the originator`);
    }
    if (/\bconst (page|originatorHeaderY|nameY|emailY|ipY) =/.test(certificate)) {
      throw new Error(`${FN}/pdf/GenerateCertificate.js: the originator block cannot move below the documents in a request`);
    }
  }
  // The signer's confirmed name again, in the signed PDF itself, whose signature says who it was
  // signed for.
  edit(PDF, [
    [
      "const signersName = _resDoc.Signers?.map(x => x.Name + ' <' + x.Email + '>');",
      "const scenticName = x => (Array.isArray(_resDoc?.ScenticSignerNames) ? _resDoc.ScenticSignerNames : []).find(n => String(n?.email || '').toLowerCase() === String(x?.Email || '').toLowerCase())?.name || x.Name;\n" +
        "        const signersName = _resDoc.Signers?.map(x => scenticName(x) + ' <' + x.Email + '>');",
      'signature reason names',
    ],
  ]);

  // ── Documents Scentic hosts the signing of ────────────────────────────────────────────────────
  //
  // A document made with the gateway's `ceremony: 'scentic'` carries ScenticCeremony: true. Scentic
  // authenticates its signers, decides whose turn it is, and submits each signature through the
  // gateway, which calls the functions below with the master key, naming the signer it acts for.
  // OpenSign's own page must not be a second way in: it knows nothing of Scentic's order (the
  // document has OpenSign's ordering off), so anybody on the document who learned its id could
  // have signed out of turn there. For these documents each function answers the server's own
  // calls only. No signer's session opens, views, signs or declines them; no code is mailed for
  // them (opensign-server-files/SendMailOTPv1.js). Every other document is untouched.
  edit(`${FN}/getDocument.js`, [
    [
      "          const IsEnableOTP = res?.get('IsEnableOTP') || false;\n          const document = JSON.parse(JSON.stringify(res));\n",
      "          const IsEnableOTP = res?.get('IsEnableOTP') || false;\n" +
        "          if (res.get('ScenticCeremony') === true && !request.master) {\n" +
        '            return { error: "You don\'t have access of this document!" };\n' +
        '          }\n' +
        '          const document = JSON.parse(JSON.stringify(res));\n',
      'getDocument for a scentic ceremony',
    ],
  ]);
  edit(PDF, [
    [
      '    const resDoc = await docQuery.first({ useMasterKey: true });\n' +
        '    if (!resDoc) {\n' +
        "      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');\n" +
        '    }\n',
      '    const resDoc = await docQuery.first({ useMasterKey: true });\n' +
        '    if (!resDoc) {\n' +
        "      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Document not found.');\n" +
        '    }\n' +
        "    if (resDoc.get('ScenticCeremony') === true && !req?.master) {\n" +
        "      throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This document is signed on another page.');\n" +
        '    }\n',
      'signPdf for a scentic ceremony',
    ],
  ]);
  edit(`${FN}/declinedocument.js`, [
    [
      "      const isEnableOTP = updateDoc?.get('IsEnableOTP') || false;\n",
      "      const isEnableOTP = updateDoc?.get('IsEnableOTP') || false;\n" +
        "      if (updateDoc.get('ScenticCeremony') === true && !request.master) {\n" +
        "        throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'This document is signed on another page.');\n" +
        '      }\n',
      'declinedoc for a scentic ceremony',
    ],
  ]);
  edit(`${FN}/triggerEvent.js`, [
    [
      "    docQuery.select(['Name', 'IsEnableOTP', 'SignedUrl', 'AuditTrail']);",
      "    docQuery.select(['Name', 'IsEnableOTP', 'SignedUrl', 'AuditTrail', 'ScenticCeremony']);",
      'triggerevent reads the ceremony mark',
    ],
    [
      // The server's own call needs no session: the gateway records a view for the signer it names.
      '    if (isEnableOTP) {\n      let userId;\n',
      "    if (docRes?.get('ScenticCeremony') === true && !request.master) {\n" +
        "      return { message: 'User not found!' };\n" +
        '    }\n' +
        '    if (isEnableOTP && !request.master) {\n      let userId;\n',
      'triggerevent for a scentic ceremony',
    ],
  ]);

  // A certificate made again later (generatecertificate, by document id) is signed "Digitally signed
  // by OpenSign", with upstream's address as the contact — the name a reader sees in their PDF
  // viewer's signature panel. The platform's name, from APP_NAME like the mails; the contact as for
  // the signed document itself.
  edit(`${FN}/generateCertificatebydocId.js`, [
    ["const eSignName = 'OpenSign';", "const eSignName = process.env.APP_NAME || 'Scentic';", 'certificate signature name'],
    [
      "const eSigncontact = 'hello@opensignlabs.com';",
      "const eSigncontact = process.env.ESIGN_CONTACT || 'esign@scentic.com';",
      'certificate signature contact',
    ],
  ]);

  return { applied, refused };
}

// Run as a script: the image build.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { applied } = applyServerPatches();
    console.log(`opensign server patched (${applied.length} edits)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
