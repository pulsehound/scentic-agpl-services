// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edits to OpenSign's built signing page, applied at image build (deploy/Dockerfile.opensign). Each
// fails the build if what it changes is not there, so a change upstream surfaces here.
//
// Every signer now opens a document with a code emailed to them (deploy/opensign-server-files). The
// code has six digits, where upstream's code field accepts exactly four; and the screens around it
// say "OTP", which a counterparty should not have to decode.
import { copyFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
  // A signer opening a link has never been here before.
  welcome: 'Welcome',
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

// The code screen is the first thing a signer sees, and it showed upstream's logo — the app's
// default, which no Scentic signer saw before because the screen never appeared. Scentic's mark,
// the same one the completion certificate carries.
const logos = readdirSync(`${BUILD}/assets`).filter((n) => /^logo-[A-Za-z0-9_-]+\.png$/.test(n));
if (logos.length !== 1) {
  console.error(`expected one default logo in assets, found ${logos.length}: upstream changed shape`);
  process.exit(1);
}
copyFileSync('/tmp/scentic-logo.png', `${BUILD}/assets/${logos[0]}`);

// New names for everything changed. Files under /assets are served immutable for a year, by name;
// a browser that had opened any signing link before would keep the four-digit field and the old
// logo. Every script imports others by name (chunks import main), so every script is renamed — a
// mix of old and new modules in one page would load two copies of the app — and every reference
// to one, in index.html and the scripts, follows. Same content, same names: rebuilds are stable.
const assets = readdirSync(`${BUILD}/assets`);
const renamed = assets.filter((n) => n.endsWith('.js') || n === logos[0]);
const digest = createHash('sha256');
for (const name of renamed.sort()) digest.update(name).update(readFileSync(`${BUILD}/assets/${name}`));
const tag = `s${digest.digest('hex').slice(0, 8)}`;
const newName = (name) => name.replace(/(\.[a-z]+)$/, `.${tag}$1`);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`(?<=[/"'\`])(${renamed.map(escape).join('|')})(?=["'\`?#)]|$)`, 'g');

const texts = ['index.html', ...assets.filter((n) => /\.(js|css|mjs)$/.test(n)).map((n) => `assets/${n}`)];
let references = 0;
for (const rel of texts) {
  const file = `${BUILD}/${rel}`;
  const text = readFileSync(file, 'utf8');
  const next = text.replace(pattern, (old) => {
    references++;
    return newName(old);
  });
  if (next !== text) writeFileSync(file, next);
}
for (const name of renamed) renameSync(`${BUILD}/assets/${name}`, `${BUILD}/assets/${newName(name)}`);
const html = readFileSync(`${BUILD}/index.html`, 'utf8');
if (!html.includes(`.${tag}.js`) || renamed.some((n) => html.includes(`/${n}"`))) {
  console.error('index.html does not name the renamed scripts');
  process.exit(1);
}
// The signing page in Scentic's own look, and a Start button: deploy/opensign-ceremony. Two files
// added beside the built ones, named by their content (assets are served immutable for a year), and
// named in index.html after the page's own stylesheets so their values win.
const CEREMONY = '/tmp/opensign-ceremony';
const ceremony = {};
for (const [kind, source] of [['css', 'scentic-ceremony.css'], ['js', 'scentic-ceremony.js']]) {
  const body = readFileSync(`${CEREMONY}/${source}`);
  const name = `scentic-ceremony.${createHash('sha256').update(body).digest('hex').slice(0, 8)}.${kind}`;
  writeFileSync(`${BUILD}/assets/${name}`, body);
  ceremony[kind] = name;
}
{
  const page = readFileSync(`${BUILD}/index.html`, 'utf8');
  if (!page.includes('</head>') || page.includes('scentic-ceremony.')) {
    console.error('index.html: no </head>, or the ceremony layer is already there');
    process.exit(1);
  }
  writeFileSync(
    `${BUILD}/index.html`,
    page.replace(
      '</head>',
      `  <link rel="stylesheet" href="/assets/${ceremony.css}">\n  <script defer src="/assets/${ceremony.js}"></script>\n</head>`,
    ),
  );
}
console.log(`opensign frontend patched (${fields} code fields, ${renamed.length} files renamed .${tag}, ${references} references)`);
