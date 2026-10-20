// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edits to OpenSign's built signing page, applied at image build (deploy/Dockerfile.opensign). Each
// fails the build if what it changes is not there, so a change upstream surfaces here.
//
// Every signer now opens a document with a code emailed to them (deploy/opensign-server-files). The
// code has six digits, where upstream's code field accepts exactly four; and the screens around it
// say "OTP", which a counterparty should not have to decode.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const BUILD = '/usr/src/app/build';
const FOUR = 'pattern:`[0-9]{4}`';
const SIX = 'pattern:`[0-9]{6}`';

let fields = 0;
for (const name of readdirSync(`${BUILD}/assets`).filter((n) => n.endsWith('.js'))) {
  const file = `${BUILD}/assets/${name}`;
  const text = readFileSync(file, 'utf8');
  if (!text.includes(FOUR)) continue;
  fields += text.split(FOUR).length - 1;
  writeFileSync(file, text.split(FOUR).join(SIX));
}
if (fields === 0) {
  console.error('code field not found: upstream changed shape');
  process.exit(1);
}

const WORDS = {
  'otp-verification': 'Enter your code',
  'enter-otp': 'We emailed you a 6-digit code. Enter it to open the document.',
  'otp-placeholder': '6-digit code',
  'get-otp-alert': 'To keep this document private, we’ll email a code to this address.',
  'get-verification-code': 'Email me a code',
  'invalid-otp': 'That code isn’t right, or it has expired. Check your latest email, or send a new code.',
  'enter-otp-alert': 'Please enter the code from your email.',
  resend: 'Send a new code',
};
const LOCALE = `${BUILD}/locales/en/translation.json`;
const strings = JSON.parse(readFileSync(LOCALE, 'utf8'));
for (const [key, value] of Object.entries(WORDS)) {
  if (!(key in strings)) {
    console.error(`${LOCALE}: no "${key}": upstream changed shape`);
    process.exit(1);
  }
  strings[key] = value;
}
writeFileSync(LOCALE, JSON.stringify(strings));
console.log(`opensign frontend patched (${fields} code fields)`);
