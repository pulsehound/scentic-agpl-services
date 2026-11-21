// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Make a completion certificate with the server's own generator, inside the server image, from a
// fixture document: `node make-certificate.mjs <out folder>`, run from the server's working
// directory (/usr/src/app) with this file placed there, so that the generator, its Utils.js, its
// font and its images are the image's own. Nothing is read from or written to a database.
//
//   docker run --rm --entrypoint node -w /usr/src/app \
//     -v "$PWD/deploy/tests/make-certificate.mjs:/usr/src/app/make-certificate.mjs:ro" \
//     -v "<out folder>:/out" <server image> make-certificate.mjs /out
//
// It writes certificate.pdf and expected.txt: one line for each thing the certificate must say.
// `node read-certificate.mjs --expect <out>/expected.txt <out>/certificate.pdf` (on a machine with
// this folder's dependencies) reads the PDF back and checks every line, and that nothing was drawn
// outside the page border.
//
// The fixture is invented: a firm, two signers, three documents sent together, the events of a
// ceremony. The platform account's company is deliberately not the firm's name.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: node make-certificate.mjs <out folder>');
  process.exit(2);
}

// Chrome inside an in-app browser on a Samsung phone: 180 characters.
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-S918BB Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 Instagram 337.0.0';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87';
const PLATFORM = 'Scentic Platform Ltd';
const FIRM = 'Cohen & Levi Law Offices';
// The second signer confirmed their name in Hebrew (F-19): read back in the order it was typed, never
// reversed.
const BOB_HE = 'רוני כהן';
const BOB_HE_REVERSED = Array.from(BOB_HE).reverse().join('');
const ORIGIN_IP = '198.51.100.24';
const HEBREW_TITLE = 'הסכם שכר טרחה';

const contact = (id, name, email) => ({ objectId: id, Name: name, Email: email, className: 'contracts_Contactbook', __type: 'Object' });
const alice = contact('c1', 'Alice (shared contact)', 'alice@example.com');
const bob = contact('c2', 'Bob (shared contact)', 'bob@example.com');
const related = [
  { position: 1, total: 3, title: 'Engagement letter', sha256: '11'.repeat(32) },
  { position: 2, total: 3, title: 'Power of attorney', sha256: '22'.repeat(32), current: true },
  { position: 3, total: 3, title: HEBREW_TITLE, sha256: '33'.repeat(32) },
];
const at = minute => new Date(Date.UTC(2026, 10, 20, 9, minute, 0)).toISOString();
const doc = {
  objectId: 'docRound76',
  Name: 'Power of attorney',
  createdAt: '2026-11-20T08:00:00.000Z',
  completedAt: '2026-11-20T09:30:00.000Z',
  DocumentHash: 'ab'.repeat(32),
  IsEnableOTP: true,
  ExtUserPtr: { Name: 'Platform Admin', Email: 'admin@platform.example', Company: PLATFORM, Timezone: 'UTC', DateFormat: 'YYYY-MM-DD', Is12HourTime: false },
  SenderName: 'Dana Levi',
  SenderMail: 'dana@cohenlevi.example',
  ScenticFirmName: FIRM,
  FirmName: FIRM,
  OriginIp: ORIGIN_IP,
  Signers: [alice, bob],
  Placeholders: [
    { Role: 'signer', email: alice.Email, signerObjId: 'c1', signerPtr: alice },
    { Role: 'signer', email: bob.Email, signerObjId: 'c2', signerPtr: bob },
  ],
  AuditTrail: [
    { UserPtr: alice, Activity: 'Signed', ipAddress: '203.0.113.7', ViewedOn: at(5), SignedOn: at(10) },
    { UserPtr: bob, Activity: 'Signed', ipAddress: '2001:db8::8a2e:370:7334', ViewedOn: at(20), SignedOn: at(30) },
  ],
  ScenticSignerNames: [
    { email: 'alice@example.com', name: 'Alice Example' },
    { email: 'bob@example.com', name: BOB_HE },
  ],
  ScenticRelatedDocuments: related,
  ScenticAudit: [
    { at: at(0), event: 'Document in this request', actor: 'Dana Levi', detail: '2 of 3: Power of attorney' },
    { at: at(4), event: 'Link opened', actor: 'Alice Example', email: 'alice@example.com', ipAddress: '203.0.113.7', userAgent: ANDROID },
    { at: at(5), event: 'Code verified', actor: 'Alice Example', email: 'alice@example.com', ipAddress: '203.0.113.7', userAgent: ANDROID },
    { at: at(10), event: 'Signed', actor: 'Alice Example', email: 'alice@example.com', ipAddress: '203.0.113.7', userAgent: ANDROID, detail: 'Signature drawn' },
    { at: at(20), event: 'Link opened', actor: 'Robert Example', email: 'bob@example.com', ipAddress: '2001:db8::8a2e:370:7334', userAgent: DESKTOP },
    { at: at(30), event: 'Signed', actor: 'Robert Example', email: 'bob@example.com', ipAddress: '2001:db8::8a2e:370:7334', userAgent: DESKTOP },
  ],
};

// Lines the certificate must contain, compared with all white space removed (a wrapped string is
// read back with a space at each line break). `!` first: must not be there.
const expected = [
  `Organization : ${FIRM}`,
  `!${PLATFORM}`,
  `Document originator Name : Dana Levi Email : dana@cohenlevi.example IP address : ${ORIGIN_IP}`,
  'Documents in this request',
  `1 of 3 — Engagement letter SHA-256 : ${'11'.repeat(32)}`,
  `2 of 3 — Power of attorney (this document) SHA-256 : ${'22'.repeat(32)}`,
  `SHA-256 : ${'33'.repeat(32)}`,
  'Name : Alice Example',
  `Name : ${BOB_HE}`,
  `!${BOB_HE_REVERSED}`,
  '!shared contact',
  'Event history',
  ANDROID,
  DESKTOP,
  '2 of 3: Power of attorney',
  '2001:db8::8a2e:370:7334',
  '2026-11-20 09:30:00 UTC',
];

const generate = (await import('./cloud/parsefunction/pdf/GenerateCertificate.js')).default;
const bytes = await generate(doc);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'certificate.pdf'), bytes);
writeFileSync(join(out, 'expected.txt'), `${expected.join('\n')}\n`);
console.log(`certificate.pdf: ${bytes.length} bytes; expected.txt: ${expected.length} lines`);
