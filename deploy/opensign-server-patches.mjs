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
console.log('opensign server patched');
