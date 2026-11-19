// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Edits to OpenSign's built signing page, applied at image build (deploy/Dockerfile.opensign). Each
// fails the build if what it changes is not there, so a change upstream surfaces here.
//
// Every signer opens a document with a code emailed to them (deploy/opensign-server-files). The
// code has six digits, where upstream's code field accepts exactly four; and the screens around it
// say "OTP", which a counterparty should not have to decode.
//
// The page also loaded a stylesheet, an icon font, four handwriting fonts, a PDF renderer's worker,
// an animation player and a text font from five other companies' servers, each of which then knew
// that somebody was opening a document on this site, and any of which could change what the page
// ran. All of it is served from this site now (selfHost* below, deploy/opensign-assets/vendor), and
// the build fails if a reference to one of those hosts is left anywhere in the built page.
//
// At image build this file is run as a script and patches /usr/src/app/build. Imported, it does
// nothing until patchFrontend is called; the text transforms are exported one by one so that
// deploy/tests can run each over a fixture.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const count = (text, part) => text.split(part).length - 1;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// ── The code field ───────────────────────────────────────────────────────────────────────────────

const FOUR = 'pattern:`[0-9]{4}`';
const SIX = 'pattern:`[0-9]{6}`';

/** The code field takes six digits. */
export function sixDigitCode(text) {
  return { text: text.split(FOUR).join(SIX), count: count(text, FOUR) };
}

// ── Wording ──────────────────────────────────────────────────────────────────────────────────────

/** OpenSign's English strings with ours over them. Every key of ours must already be upstream's. */
export function localeWith(strings, words) {
  const next = { ...strings };
  for (const [key, value] of Object.entries(words)) {
    if (!(key in strings)) throw new Error(`no "${key}" in the page's strings: upstream changed shape`);
    next[key] = value;
  }
  return next;
}

/** What scentic-ceremony.js needs to tell a closed document by: the page's own titles and sentences. */
export function stateWords(strings, states) {
  const need = key => {
    if (typeof strings[key] !== 'string' || strings[key] === '') throw new Error(`no "${key}" in the page's strings`);
    return strings[key];
  };
  return {
    declinedTitle: need(states.declinedTitle),
    expiredTitle: need(states.expiredTitle),
    finished: states.finished.map(need),
  };
}

/** The ceremony script with this build's wording in front of it. */
export function ceremonyScript(source, words) {
  // JSON is JavaScript here, but for "<" (a closing script tag) and the two line separators a
  // script cannot hold raw; all three are written as escapes.
  let json = JSON.stringify(words).split('<').join('\\x3c');
  for (const code of [0x2028, 0x2029]) json = json.split(String.fromCharCode(code)).join(`\\u${code.toString(16)}`);
  return `window.SCENTIC_STATE_WORDS=${json};\n${source}`;
}

// ── Messages in the page, not in a browser dialog ────────────────────────────────────────────────

const NOTICE = '(window.scenticNotice||alert)(';
const BARE_ALERT = /(?<![\w$.])alert\(/g;
const NO_SUCH_USER_ALERT = /(?<![\w$.])alert\((?=[A-Za-z_$][\w$]*\(`user-not-exist`\)\))/g;

/**
 * The page's own messages are shown in the page (scentic-ceremony.js, window.scenticNotice) rather
 * than in a browser dialog. `every`: all of a file's alerts — the code screen, where each is a
 * message to a signer. Otherwise only "we couldn't open this document for you", which is what a
 * withdrawn or unavailable link raised. If the ceremony script is not there, alert still is.
 */
export function inlineNotices(text, { every = false } = {}) {
  const pattern = every ? BARE_ALERT : NO_SUCH_USER_ALERT;
  let replaced = 0;
  const next = text.replace(pattern, () => {
    replaced++;
    return NOTICE;
  });
  return { text: next, count: replaced };
}

// ── Nothing from anybody else's server ───────────────────────────────────────────────────────────

/** The hosts the built page must not name. */
export const THIRD_PARTY_HOSTS = [
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdn.opensignlabs.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'digitaloceanspaces.com',
];

/** Which of those hosts a text still names. */
export function thirdPartyReferences(text) {
  return THIRD_PARTY_HOSTS.filter(host => text.includes(host));
}

const BOOTSTRAP_LINK = /<link\s+rel="stylesheet"\s+href="https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@4\.0\.0\/dist\/css\/bootstrap\.min\.css"[^>]*>/;
const ICONS_LINK = /<link\s+rel="stylesheet"\s+href="https:\/\/cdn\.opensignlabs\.com\/fonts\.css"\s*\/?>/;

/** index.html: Bootstrap's stylesheet and the icon font's, from this site. */
export function selfHostIndexHtml(html, { bootstrapHref, iconsHref }) {
  if (!BOOTSTRAP_LINK.test(html)) throw new Error('index.html: the Bootstrap stylesheet link is not there: upstream changed shape');
  if (!ICONS_LINK.test(html)) throw new Error('index.html: the icon font stylesheet link is not there: upstream changed shape');
  return html
    .replace(BOOTSTRAP_LINK, `<link rel="stylesheet" href="${bootstrapHref}" />`)
    .replace(ICONS_LINK, `<link rel="stylesheet" href="${iconsHref}" />`);
}

const PDF_WORKER = /`\/\/unpkg\.com\/pdfjs-dist@\$\{[A-Za-z_$][\w$]*\}\/legacy\/build\/pdf\.worker\.min\.mjs`/g;
const LOTTIE_WASM = /`https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com)\/\$\{[A-Za-z_$][\w$]*\}@\$\{[A-Za-z_$][\w$]*\}\/dist\/dotlottie-player\.wasm`/g;
const TIMES_FONT = '`https://cdn.opensignlabs.com/webfonts/times.ttf`';
const UPSTREAM_LOGO = 'https://qikinnovation.ams3.digitaloceanspaces.com/logo.png';
// The two places the logo's address is written, both inside template literals: an email body the
// page composes, and the email designer's default block.
const LOGO_IN_MAIL = `<img src='${UPSTREAM_LOGO}' height='50' /></div><div style='padding:2px;font-family:system-ui;background-color:\${`;
const LOGO_IN_DESIGNER = `url:\`${UPSTREAM_LOGO}\``;

/**
 * A script of the page, with what it fetched from other hosts fetched from this one: the PDF
 * renderer's worker, the animation player, the text font stamped into a PDF, and the logo put in
 * an email (which is read somewhere else, so it gets this site's full address, not a path).
 */
export function selfHostScript(text, { pdfWorkerHref, lottieHref, timesHref, logoPath }) {
  const counts = { pdfWorker: 0, lottie: 0, times: 0, logo: 0 };
  let next = text.replace(PDF_WORKER, () => {
    counts.pdfWorker++;
    return `\`${pdfWorkerHref}\``;
  });
  next = next.replace(LOTTIE_WASM, () => {
    counts.lottie++;
    return `\`${lottieHref}\``;
  });
  counts.times = count(next, TIMES_FONT);
  next = next.split(TIMES_FONT).join(`\`${timesHref}\``);
  const ours = `\${window.location.origin}${logoPath}`;
  counts.logo = count(next, LOGO_IN_MAIL) + count(next, LOGO_IN_DESIGNER);
  next = next
    .split(LOGO_IN_MAIL)
    .join(LOGO_IN_MAIL.replace(UPSTREAM_LOGO, ours))
    .split(LOGO_IN_DESIGNER)
    .join(LOGO_IN_DESIGNER.replace(UPSTREAM_LOGO, ours));
  return { text: next, counts };
}

const GOOGLE_FONT_IMPORT = /@import\s*(?:url\()?["']https:\/\/fonts\.googleapis\.com\/css2\?family=([A-Za-z+]+)[^"']*["']\)?\s*;/g;

/** The faces a typed signature can be drawn in; the ones deploy/opensign-assets/vendor holds. */
export const HANDWRITING_FAMILIES = ['Cedarville Cursive', 'Dancing Script', 'Delicious Handrawn', 'Fasthand'];

/** A stylesheet's imports from Google Fonts, replaced by one import of the same faces from this site. */
export function selfHostHandwriting(css, href) {
  const families = [];
  const without = css.replace(GOOGLE_FONT_IMPORT, (_all, family) => {
    families.push(family.replace(/\+/g, ' '));
    return '';
  });
  const unknown = families.filter(f => !HANDWRITING_FAMILIES.includes(f));
  if (unknown.length > 0) throw new Error(`a font this site does not hold is imported: ${unknown.join(', ')}`);
  // @import must come before every other rule, which is where the ones removed were.
  return { text: families.length > 0 ? `@import "${href}";${without}` : css, families };
}

// ── The build ────────────────────────────────────────────────────────────────────────────────────

/** Monotype's Times New Roman as upstream ships it with the server (font/times.ttf). Not ours to commit. */
export const TIMES_SHA256 = '51966b27ce9d5a3f58bc4890b98bdd08efd9683b9265251ddaf09b8965a849ea';

function walk(root, under = '') {
  const out = [];
  for (const name of readdirSync(under ? `${root}/${under}` : root)) {
    const rel = under ? `${under}/${name}` : name;
    if (statSync(`${root}/${rel}`).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** The files deploy/opensign-assets/vendor holds, each checked against its recorded hash. */
export function verifiedVendorFiles(vendorDir) {
  const manifest = JSON.parse(readFileSync(`${vendorDir}/MANIFEST.json`, 'utf8'));
  for (const entry of manifest.files) {
    const actual = sha256(readFileSync(`${vendorDir}/${entry.path}`));
    if (actual !== entry.sha256) throw new Error(`${entry.path}: not the file the manifest names (sha256 ${actual})`);
  }
  const listed = new Set(manifest.files.map(f => f.path));
  const stray = walk(vendorDir).filter(rel => rel !== 'MANIFEST.json' && !listed.has(rel));
  if (stray.length > 0) throw new Error(`files the manifest does not name: ${stray.join(', ')}`);
  return manifest.files;
}

/**
 * Patch a built page in place.
 *
 * build        the page's build folder (index.html, assets/, locales/)
 * logo         Scentic's mark, a PNG
 * ceremonyDir  deploy/opensign-ceremony
 * vendorDir    deploy/opensign-assets/vendor
 * nodeModules  the page's own node_modules, for the two files copied from the packages it was built with
 * timesFont    font/times.ttf from the server image
 */
export function patchFrontend({ build, logo, ceremonyDir, vendorDir, nodeModules, timesFont }) {
  const assetNames = () => readdirSync(`${build}/assets`).filter(n => statSync(`${build}/assets/${n}`).isFile());
  const scripts = () => assetNames().filter(n => n.endsWith('.js'));

  // Six digits.
  let fields = 0;
  for (const name of scripts()) {
    const file = `${build}/assets/${name}`;
    const result = sixDigitCode(readFileSync(file, 'utf8'));
    if (result.count === 0) continue;
    fields += result.count;
    writeFileSync(file, result.text);
  }
  if (fields === 0) throw new Error('code field not found: upstream changed shape');

  // Plain words.
  const words = JSON.parse(readFileSync(`${ceremonyDir}/words.json`, 'utf8'));
  const LOCALE = `${build}/locales/en/translation.json`;
  const strings = localeWith(JSON.parse(readFileSync(LOCALE, 'utf8')), words.locale);
  writeFileSync(LOCALE, JSON.stringify(strings));

  // The code screen is the first thing a signer sees, and it showed upstream's logo — the app's
  // default, which no Scentic signer saw before because the screen never appeared. Scentic's mark,
  // the same one the completion certificate carries.
  const logos = assetNames().filter(n => /^logo-[A-Za-z0-9_-]+\.png$/.test(n));
  if (logos.length !== 1) throw new Error(`expected one default logo in assets, found ${logos.length}: upstream changed shape`);
  copyFileSync(logo, `${build}/assets/${logos[0]}`);

  // Messages in the page. The code screen: every one. Elsewhere: the one a link that cannot be
  // opened raised.
  const notices = { codeScreen: 0, unavailable: 0 };
  for (const name of scripts()) {
    const file = `${build}/assets/${name}`;
    const codeScreen = /^GuestLogin-/.test(name);
    const result = inlineNotices(readFileSync(file, 'utf8'), { every: codeScreen });
    if (result.count === 0) continue;
    notices[codeScreen ? 'codeScreen' : 'unavailable'] += result.count;
    writeFileSync(file, result.text);
  }
  if (notices.codeScreen === 0) throw new Error("the code screen's messages were not found: upstream changed shape");
  if (notices.unavailable === 0) throw new Error('the unavailable-link message was not found: upstream changed shape');

  // Everything the page fetched from other hosts, into one folder of this site. Named by what is in
  // it: files under /assets are served immutable for a year.
  const vendorFiles = verifiedVendorFiles(vendorDir);
  const times = readFileSync(timesFont);
  if (sha256(times) !== TIMES_SHA256) throw new Error(`${timesFont}: not the font the page was written for`);
  const pdfjs = JSON.parse(readFileSync(`${nodeModules}/pdfjs-dist/package.json`, 'utf8')).version;
  const lottie = JSON.parse(readFileSync(`${nodeModules}/@lottiefiles/dotlottie-web/package.json`, 'utf8')).version;
  const worker = readFileSync(`${nodeModules}/pdfjs-dist/legacy/build/pdf.worker.min.mjs`);
  const wasm = readFileSync(`${nodeModules}/@lottiefiles/dotlottie-web/dist/dotlottie-player.wasm`);
  // The worker and the player must be the versions the page was built against, which it names.
  const built = scripts().map(n => readFileSync(`${build}/assets/${n}`, 'utf8')).join('\n');
  for (const [what, version] of [['pdfjs-dist', pdfjs], ['@lottiefiles/dotlottie-web', lottie]]) {
    if (!built.includes(`\`${version}\``) && !built.includes(`"${version}"`) && !built.includes(`'${version}'`)) {
      throw new Error(`the page was not built against ${what} ${version}, the version installed beside it`);
    }
  }
  const vendorDigest = createHash('sha256');
  for (const entry of vendorFiles) vendorDigest.update(entry.path).update(entry.sha256);
  vendorDigest.update(times).update(worker).update(wasm);
  const vendorName = `vendor-${vendorDigest.digest('hex').slice(0, 8)}`;
  const vendorOut = `${build}/assets/${vendorName}`;
  if (existsSync(vendorOut)) throw new Error(`${vendorOut}: already there — the page is already patched`);
  mkdirSync(vendorOut, { recursive: true });
  for (const entry of vendorFiles) {
    mkdirSync(`${vendorOut}/${entry.path}`.replace(/\/[^/]*$/, ''), { recursive: true });
    copyFileSync(`${vendorDir}/${entry.path}`, `${vendorOut}/${entry.path}`);
  }
  writeFileSync(`${vendorOut}/times.ttf`, times);
  writeFileSync(`${vendorOut}/pdf.worker.min.mjs`, worker);
  writeFileSync(`${vendorOut}/dotlottie-player.wasm`, wasm);
  const href = rel => `/assets/${vendorName}/${rel}`;

  const selfHosted = { pdfWorker: 0, lottie: 0, times: 0, logo: 0, handwriting: 0 };
  for (const name of scripts()) {
    const file = `${build}/assets/${name}`;
    const result = selfHostScript(readFileSync(file, 'utf8'), {
      pdfWorkerHref: href('pdf.worker.min.mjs'),
      lottieHref: href('dotlottie-player.wasm'),
      timesHref: href('times.ttf'),
      // The logo copied over the page's own a moment ago; it is renamed below, and this with it.
      logoPath: `/assets/${logos[0]}`,
    });
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    for (const key of Object.keys(result.counts)) selfHosted[key] += result.counts[key];
    writeFileSync(file, result.text);
  }
  const restyled = [];
  for (const name of assetNames().filter(n => n.endsWith('.css'))) {
    const file = `${build}/assets/${name}`;
    const result = selfHostHandwriting(readFileSync(file, 'utf8'), href('handwriting/handwriting.css'));
    if (result.families.length === 0) continue;
    selfHosted.handwriting += result.families.length;
    restyled.push(name);
    writeFileSync(file, result.text);
  }
  for (const [what, n] of Object.entries(selfHosted)) {
    if (n === 0) throw new Error(`nothing to serve from this site for "${what}": upstream changed shape`);
  }
  writeFileSync(
    `${build}/index.html`,
    selfHostIndexHtml(readFileSync(`${build}/index.html`, 'utf8'), {
      bootstrapHref: href('bootstrap-4.0.0/bootstrap.min.css'),
      iconsHref: href('fontawesome-free-6.5.2/css/all.min.css'),
    }),
  );

  // New names for everything changed. Files under /assets are served immutable for a year, by name;
  // a browser that had opened any signing link before would keep the four-digit field and the old
  // logo. Every script imports others by name (chunks import main), so every script is renamed — a
  // mix of old and new modules in one page would load two copies of the app — and every reference
  // to one, in index.html and the scripts, follows. Same content, same names: rebuilds are stable.
  const assets = assetNames();
  const renamed = assets.filter(n => n.endsWith('.js') || n === logos[0] || restyled.includes(n));
  const digest = createHash('sha256');
  for (const name of renamed.sort()) digest.update(name).update(readFileSync(`${build}/assets/${name}`));
  const tag = `s${digest.digest('hex').slice(0, 8)}`;
  const newName = name => name.replace(/(\.[a-z]+)$/, `.${tag}$1`);
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<=[/"'\`])(${renamed.map(escape).join('|')})(?=["'\`?#)]|$)`, 'g');

  const texts = ['index.html', ...assets.filter(n => /\.(js|css|mjs)$/.test(n)).map(n => `assets/${n}`)];
  let references = 0;
  for (const rel of texts) {
    const file = `${build}/${rel}`;
    const text = readFileSync(file, 'utf8');
    const next = text.replace(pattern, old => {
      references++;
      return newName(old);
    });
    if (next !== text) writeFileSync(file, next);
  }
  for (const name of renamed) renameSync(`${build}/assets/${name}`, `${build}/assets/${newName(name)}`);
  const html = readFileSync(`${build}/index.html`, 'utf8');
  if (!html.includes(`.${tag}.js`) || renamed.some(n => html.includes(`/${n}"`))) {
    throw new Error('index.html does not name the renamed scripts');
  }

  // The signing page in Scentic's own look, and a Start button: deploy/opensign-ceremony. Two files
  // added beside the built ones, named by their content (assets are served immutable for a year),
  // and named in index.html after the page's own stylesheets so their values win.
  const ceremony = {};
  const sources = {
    css: readFileSync(`${ceremonyDir}/scentic-ceremony.css`),
    js: Buffer.from(ceremonyScript(readFileSync(`${ceremonyDir}/scentic-ceremony.js`, 'utf8'), stateWords(strings, words.states))),
  };
  for (const [kind, body] of Object.entries(sources)) {
    const name = `scentic-ceremony.${sha256(body).slice(0, 8)}.${kind}`;
    writeFileSync(`${build}/assets/${name}`, body);
    ceremony[kind] = name;
  }
  {
    const page = readFileSync(`${build}/index.html`, 'utf8');
    if (!page.includes('</head>') || page.includes('scentic-ceremony.')) {
      throw new Error('index.html: no </head>, or the ceremony layer is already there');
    }
    writeFileSync(
      `${build}/index.html`,
      page.replace(
        '</head>',
        `  <link rel="stylesheet" href="/assets/${ceremony.css}">\n  <script defer src="/assets/${ceremony.js}"></script>\n</head>`,
      ),
    );
  }

  // Last, over everything that will be served: no page, script or stylesheet names another host
  // this page used to load from.
  const leftovers = [];
  for (const rel of walk(build)) {
    if (!/\.(html|js|mjs|css|json)$/.test(rel)) continue;
    const hosts = thirdPartyReferences(readFileSync(`${build}/${rel}`, 'utf8'));
    if (hosts.length > 0) leftovers.push(`${rel}: ${hosts.join(', ')}`);
  }
  if (leftovers.length > 0) throw new Error(`still loaded from another host:\n  ${leftovers.join('\n  ')}`);

  return { fields, renamed: renamed.length, tag, references, notices, selfHosted, vendorName, ceremony };
}

// Run as a script: the image build.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = patchFrontend({
      build: '/usr/src/app/build',
      logo: '/tmp/scentic-logo.png',
      ceremonyDir: '/tmp/opensign-ceremony',
      vendorDir: '/tmp/opensign-vendor',
      nodeModules: '/usr/src/app/node_modules',
      timesFont: '/tmp/opensign-times.ttf',
    });
    console.log(
      `opensign frontend patched (${r.fields} code fields, ${r.renamed} files renamed .${r.tag}, ${r.references} references, ` +
        `${r.notices.codeScreen + r.notices.unavailable} messages in the page, served from /assets/${r.vendorName}: ${JSON.stringify(r.selfHosted)})`,
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
