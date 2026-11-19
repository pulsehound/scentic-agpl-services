// SPDX-License-Identifier: AGPL-3.0-or-later
//
// deploy/opensign-frontend-patches.mjs. The page it patches exists only built and minified, inside
// the upstream image, so there is no vendored file to run it over: each transform is run over a
// fixture cut from that built page (the shapes below are copied from it), and the whole of
// patchFrontend over a small build folder laid out like it. That the real page takes the patch is
// shown by building the image (README, "Tests"): the script fails the build when anything is missing.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HANDWRITING_FAMILIES,
  THIRD_PARTY_HOSTS,
  TIMES_SHA256,
  ceremonyScript,
  inlineNotices,
  localeWith,
  patchFrontend,
  selfHostHandwriting,
  selfHostIndexHtml,
  selfHostScript,
  sixDigitCode,
  stateWords,
  thirdPartyReferences,
  verifiedVendorFiles,
} from '../opensign-frontend-patches.mjs';
import { DEPLOY, VENDOR_FRONTEND, VENDOR_SERVER, hasVendor } from './helpers.mjs';

const VENDOR_ASSETS = join(DEPLOY, 'opensign-assets', 'vendor');
const CEREMONY = join(DEPLOY, 'opensign-ceremony');
const words = JSON.parse(readFileSync(join(CEREMONY, 'words.json'), 'utf8'));

// Shapes copied from the built page (image mirror.gcr.io/opensign/opensign@sha256:4c62e38d…).
const INDEX_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="opensigncss">
<head>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@4.0.0/dist/css/bootstrap.min.css"
    integrity="sha384-Gn5384xqQ1aoWXA+058RXPxPg6fy4IWvTNh0E263XmFcJlSAwiGgFAW/dAiS6JXm" crossorigin="anonymous" />
  <link rel="stylesheet" href="https://cdn.opensignlabs.com/fonts.css" />
  <title>...Loading</title>
  <script type="module" crossorigin src="/assets/main-AAAA.js"></script>
  <link rel="modulepreload" crossorigin href="/assets/utils-BBBB.js">
  <link rel="stylesheet" crossorigin href="/assets/signature-CCCC.css">
</head>
<body><div id="root"></div></body>
</html>`;
const MAIN_JS =
  'import"./utils-BBBB.js";var _I=`0.44.0`,vI=`@lottiefiles/dotlottie-web`;' +
  'var WI=hhe(NI,`https://cdn.jsdelivr.net/npm/${vI}@${_I}/dist/dotlottie-player.wasm`,`https://unpkg.com/${vI}@${_I}/dist/dotlottie-player.wasm`);' +
  'var im=`5.4.296`;gp.workerSrc=`//unpkg.com/pdfjs-dist@${im}/legacy/build/pdf.worker.min.mjs`;' +
  'if(t&&t===`user does not exist!`)alert(e(`user-not-exist`));else x();try{}catch{alert(e(`user-not-exist`))}' +
  'n?.totalPages===1?alert(e(`delete-alert`)):y();const lazy=()=>import("./GuestLogin-DDDD.js");';
const UTILS_JS =
  'jR=async(e,t,n)=>{let r=await nR(`https://cdn.opensignlabs.com/webfonts/times.ttf`);return r},' +
  'GR=async(e)=>{let o=await nR(`https://cdn.opensignlabs.com/webfonts/times.ttf`);return o};' +
  "const mail=`<div style='padding:10px'><img src='https://qikinnovation.ams3.digitaloceanspaces.com/logo.png' height='50' /></div><div style='padding:2px;font-family:system-ui;background-color:${m}'>`;" +
  'const block={props:{width:null,height:50,url:`https://qikinnovation.ams3.digitaloceanspaces.com/logo.png`,alt:`logo`}};const logo="/assets/logo-EEEE.png";';
const GUEST_JS =
  'const f={pattern:`[0-9]{4}`};try{}catch{alert(e(`something-went-wrong-mssg`))}' +
  'if(r===`Invalid Otp`)alert(e(`invalid-otp`));else if(r===`user not found!`)alert(e(`user-not-found`));' +
  'else alert(e(`enter-otp-alert`));if(!ok)alert(e(`valid-email-alert`));window.myalert(1);obj.alert(2);';
const SIGNATURE_CSS =
  '@import "https://fonts.googleapis.com/css2?family=Fasthand&display=swap";@import "https://fonts.googleapis.com/css2?family=Dancing+Script&display=swap";' +
  '@import "https://fonts.googleapis.com/css2?family=Delicious+Handrawn&display=swap";@import "https://fonts.googleapis.com/css2?family=Cedarville+Cursive&display=swap";' +
  '.signature{font-family:Fasthand}';

const HREFS = { pdfWorkerHref: '/assets/v/pdf.worker.min.mjs', lottieHref: '/assets/v/dotlottie-player.wasm', timesHref: '/assets/v/times.ttf', logoPath: '/assets/logo-EEEE.png' };

describe('page patches: each transform over text cut from the built page', () => {
  it('the code field takes six digits', () => {
    const r = sixDigitCode(GUEST_JS);
    expect(r.count).toBe(1);
    expect(r.text).toContain('pattern:`[0-9]{6}`');
    expect(sixDigitCode(r.text).count).toBe(0);
  });

  it("our words go over upstream's, and a key upstream no longer has is refused", () => {
    expect(localeWith({ a: 'x', b: 'y' }, { a: 'z' })).toEqual({ a: 'z', b: 'y' });
    expect(() => localeWith({ a: 'x' }, { gone: 'z' })).toThrow(/no "gone"/);
  });

  it('index.html: Bootstrap and the icon font come from this site, and the integrity attribute goes with the link it described', () => {
    const html = selfHostIndexHtml(INDEX_HTML, { bootstrapHref: '/assets/v/b.css', iconsHref: '/assets/v/fa.css' });
    expect(html).toContain('<link rel="stylesheet" href="/assets/v/b.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/assets/v/fa.css" />');
    expect(html).not.toContain('integrity=');
    expect(thirdPartyReferences(html)).toEqual([]);
    // A second run finds nothing to change and says so, rather than passing quietly.
    expect(() => selfHostIndexHtml(html, { bootstrapHref: '/x', iconsHref: '/y' })).toThrow(/upstream changed shape/);
  });

  it('scripts: the PDF worker, the animation player, the text font and the logo come from this site', () => {
    const main = selfHostScript(MAIN_JS, HREFS);
    expect(main.counts).toEqual({ pdfWorker: 1, lottie: 2, times: 0, logo: 0 });
    expect(main.text).toContain('gp.workerSrc=`/assets/v/pdf.worker.min.mjs`');
    expect(main.text).toContain('hhe(NI,`/assets/v/dotlottie-player.wasm`,`/assets/v/dotlottie-player.wasm`)');
    const utils = selfHostScript(UTILS_JS, HREFS);
    expect(utils.counts).toEqual({ pdfWorker: 0, lottie: 0, times: 2, logo: 2 });
    expect(utils.text).toContain('nR(`/assets/v/times.ttf`)');
    // In an email the logo needs the site's whole address; both places are template literals.
    expect(utils.text).toContain("<img src='${window.location.origin}/assets/logo-EEEE.png' height='50' />");
    expect(utils.text).toContain('url:`${window.location.origin}/assets/logo-EEEE.png`');
    for (const text of [main.text, utils.text]) {
      expect(thirdPartyReferences(text)).toEqual([]);
      expect(() => new Function(text.replace(/^import"[^"]+";/, '').replace(/import\(/g, 'imp('))).not.toThrow();
      expect(selfHostScript(text, HREFS).counts).toEqual({ pdfWorker: 0, lottie: 0, times: 0, logo: 0 });
    }
  });

  it('the logo written any other way is left, so the final check catches it rather than a guess rewriting it', () => {
    const odd = 'const u="https://qikinnovation.ams3.digitaloceanspaces.com/logo.png";';
    const r = selfHostScript(odd, HREFS);
    expect(r.counts.logo).toBe(0);
    expect(thirdPartyReferences(r.text)).toEqual(['digitaloceanspaces.com']);
  });

  it('stylesheet: four imports from Google become one from this site, first in the file', () => {
    const r = selfHostHandwriting(SIGNATURE_CSS, '/assets/v/handwriting/handwriting.css');
    expect(r.families.sort()).toEqual([...HANDWRITING_FAMILIES].sort());
    expect(r.text).toBe('@import "/assets/v/handwriting/handwriting.css";.signature{font-family:Fasthand}');
    expect(selfHostHandwriting(r.text, '/x').families).toEqual([]);
    expect(() => selfHostHandwriting('@import "https://fonts.googleapis.com/css2?family=Pacifico&display=swap";', '/x')).toThrow(/Pacifico/);
  });

  it('the code screen: every alert becomes a message in the page; elsewhere only "could not open"', () => {
    const guest = inlineNotices(GUEST_JS, { every: true });
    expect(guest.count).toBe(5);
    expect(guest.text).not.toMatch(/(?<![\w$.|])alert\(/);
    expect(guest.text).toContain('(window.scenticNotice||alert)(e(`something-went-wrong-mssg`))');
    // Not something merely named like it.
    expect(guest.text).toContain('window.myalert(1)');
    expect(guest.text).toContain('obj.alert(2)');
    expect(inlineNotices(guest.text, { every: true }).count).toBe(0);

    const main = inlineNotices(MAIN_JS);
    expect(main.count).toBe(2);
    expect(main.text).toContain('alert(e(`delete-alert`))');
    expect(main.text).toContain('(window.scenticNotice||alert)(e(`user-not-exist`))');
    expect(inlineNotices(main.text).count).toBe(0);
    for (const text of [guest.text, main.text]) {
      expect(() => new Function(text.replace(/^import"[^"]+";/, '').replace(/import\(/g, 'imp('))).not.toThrow();
    }
  });

  it('the patched call shows the message in the page when the ceremony script is there, and falls back to alert when it is not', () => {
    const calls = [];
    const run = (window, alert) => new Function('window', 'alert', 'e', inlineNotices('alert(e(`user-not-exist`))').text)(window, alert, k => `t:${k}`);
    run({ scenticNotice: m => calls.push(['notice', m]) }, m => calls.push(['alert', m]));
    run({}, m => calls.push(['alert', m]));
    expect(calls).toEqual([['notice', 't:user-not-exist'], ['alert', 't:user-not-exist']]);
  });

  it("the ceremony script is given this build's wording, safely", () => {
    const strings = localeWith(Object.fromEntries(Object.keys(words.locale).map(k => [k, 'upstream'])), words.locale);
    const state = stateWords(strings, words.states);
    expect(state.declinedTitle).toBe('Decline to sign');
    expect(state.finished).toHaveLength(words.states.finished.length);
    expect(() => stateWords({}, words.states)).toThrow();
    const script = ceremonyScript('var after=1;', { declinedTitle: '</script><b>', finished: [`a${String.fromCharCode(0x2028)}b`] });
    expect(script).not.toContain('</script>');
    expect(script).not.toContain(String.fromCharCode(0x2028));
    const window = {};
    new Function('window', script)(window);
    expect(window.SCENTIC_STATE_WORDS).toEqual({ declinedTitle: '</script><b>', finished: [`a${String.fromCharCode(0x2028)}b`] });
  });

  it('the wording is plain: no jargon, nothing left of upstream\'s phrasing', () => {
    for (const [key, value] of Object.entries(words.locale)) {
      expect(value, key).not.toMatch(/\bOTP\b|revoked|dispatched|Congratulations|🎉|does not exist|refreshing this page may/i);
      expect(value.trim(), key).toBe(value);
    }
  });
});

describe('the files served from this site instead of other hosts', () => {
  it('every file is the one its manifest entry names, and nothing unlisted is there', () => {
    const files = verifiedVendorFiles(VENDOR_ASSETS);
    expect(files.map(f => f.path)).toEqual(expect.arrayContaining([
      'bootstrap-4.0.0/bootstrap.min.css',
      'fontawesome-free-6.5.2/css/all.min.css',
      'fontawesome-free-6.5.2/webfonts/fa-solid-900.woff2',
      'handwriting/handwriting.css',
    ]));
    for (const f of files) expect(f.licence, f.path).toMatch(/MIT|OFL-1\.1|AGPL-3\.0-or-later/);
  });

  it("Bootstrap is the file upstream's own integrity attribute names", () => {
    const sri = createHash('sha384').update(readFileSync(join(VENDOR_ASSETS, 'bootstrap-4.0.0', 'bootstrap.min.css'))).digest('base64');
    expect(INDEX_HTML).toContain(`integrity="sha384-${sri}"`);
  });

  it('each handwriting face the page can ask for has a font here, with its licence', () => {
    const css = readFileSync(join(VENDOR_ASSETS, 'handwriting', 'handwriting.css'), 'utf8');
    for (const family of HANDWRITING_FAMILIES) {
      const slug = family.toLowerCase().replace(/ /g, '-');
      expect(css).toContain(`font-family: '${family}'`);
      expect(css).toContain(`url(./${slug}.woff2)`);
      expect(readFileSync(join(VENDOR_ASSETS, 'handwriting', `${slug}.woff2`)).subarray(0, 4).toString('latin1')).toBe('wOF2');
      expect(readFileSync(join(VENDOR_ASSETS, 'handwriting', `OFL-${slug}.txt`), 'utf8')).toContain('SIL Open Font License');
    }
    expect(thirdPartyReferences(css)).toEqual([]);
  });

  it('the icon font is the free edition, its stylesheet names only files that are here or its own fallbacks, and the ceremony stylesheet maps the paid styles onto it', () => {
    const css = readFileSync(join(VENDOR_ASSETS, 'fontawesome-free-6.5.2', 'css', 'all.min.css'), 'utf8');
    expect(css).toContain('Font Awesome Free 6.5.2');
    expect(css).not.toContain('Font Awesome 6 Pro');
    for (const url of new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map(m => m[1]))) {
      expect(existsSync(join(VENDOR_ASSETS, 'fontawesome-free-6.5.2', 'css', url)), url).toBe(true);
    }
    const ours = readFileSync(join(CEREMONY, 'scentic-ceremony.css'), 'utf8');
    expect(ours).toMatch(/\.fa-light,[\s\S]*font-family: 'Font Awesome 6 Free' !important;[\s\S]*font-weight: 900 !important;/);
    expect(readFileSync(join(VENDOR_ASSETS, 'fontawesome-free-6.5.2', 'LICENSE.txt'), 'utf8')).toContain('Font Awesome Free License');
  });

  it.skipIf(!hasVendor)('the text font is not committed; the one upstream ships with its server is the one the build accepts', () => {
    expect(createHash('sha256').update(readFileSync(join(VENDOR_SERVER, 'font', 'times.ttf'))).digest('hex')).toBe(TIMES_SHA256);
    expect(readdirSync(VENDOR_ASSETS, { recursive: true }).some(f => String(f).endsWith('times.ttf'))).toBe(false);
  });
});

describe('patchFrontend over a small build folder laid out like the page', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });

  function layOut({ timesBytes } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'opensign-page-'));
    const build = join(dir, 'build');
    mkdirSync(join(build, 'assets'), { recursive: true });
    mkdirSync(join(build, 'locales', 'en'), { recursive: true });
    writeFileSync(join(build, 'index.html'), INDEX_HTML);
    writeFileSync(join(build, 'assets', 'main-AAAA.js'), MAIN_JS);
    writeFileSync(join(build, 'assets', 'utils-BBBB.js'), UTILS_JS);
    writeFileSync(join(build, 'assets', 'GuestLogin-DDDD.js'), GUEST_JS);
    writeFileSync(join(build, 'assets', 'signature-CCCC.css'), SIGNATURE_CSS);
    writeFileSync(join(build, 'assets', 'main-FFFF.css'), '.x{color:red}');
    writeFileSync(join(build, 'assets', 'logo-EEEE.png'), 'upstream logo');
    writeFileSync(join(build, 'locales', 'en', 'translation.json'), JSON.stringify(Object.fromEntries(Object.keys(words.locale).map(k => [k, `upstream ${k}`]))));
    const nodeModules = join(dir, 'node_modules');
    mkdirSync(join(nodeModules, 'pdfjs-dist', 'legacy', 'build'), { recursive: true });
    mkdirSync(join(nodeModules, '@lottiefiles', 'dotlottie-web', 'dist'), { recursive: true });
    writeFileSync(join(nodeModules, 'pdfjs-dist', 'package.json'), '{"version":"5.4.296"}');
    writeFileSync(join(nodeModules, 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs'), 'export{};');
    writeFileSync(join(nodeModules, '@lottiefiles', 'dotlottie-web', 'package.json'), '{"version":"0.44.0"}');
    writeFileSync(join(nodeModules, '@lottiefiles', 'dotlottie-web', 'dist', 'dotlottie-player.wasm'), 'wasm');
    const timesFont = join(dir, 'times.ttf');
    writeFileSync(timesFont, timesBytes ?? (hasVendor ? readFileSync(join(VENDOR_SERVER, 'font', 'times.ttf')) : 'not the font'));
    return { build, logo: join(DEPLOY, 'opensign-assets', 'logo.png'), ceremonyDir: CEREMONY, vendorDir: VENDOR_ASSETS, nodeModules, timesFont };
  }
  const everyText = build =>
    readdirSync(build, { recursive: true }).map(String).filter(f => /\.(html|js|mjs|css|json)$/.test(f)).map(f => [f.replace(/\\/g, '/'), readFileSync(join(build, f), 'utf8')]);

  it.skipIf(!hasVendor)('nothing in the patched page names another host, everything it names is there, and a second run is refused', () => {
    const opts = layOut();
    const r = patchFrontend(opts);
    expect(r.selfHosted).toEqual({ pdfWorker: 1, lottie: 2, times: 2, logo: 2, handwriting: 4 });
    expect(r.notices).toEqual({ codeScreen: 5, unavailable: 2 });
    expect(r.fields).toBe(1);

    for (const [file, text] of everyText(opts.build)) expect(thirdPartyReferences(text), file).toEqual([]);
    const html = readFileSync(join(opts.build, 'index.html'), 'utf8');
    for (const host of THIRD_PARTY_HOSTS) expect(html).not.toContain(host);
    // Every local address index.html and the scripts name is a file in the build.
    const named = new Set();
    for (const [, text] of everyText(opts.build)) for (const m of text.matchAll(/\/assets\/[A-Za-z0-9._/-]+\.(?:js|mjs|css|png|ttf|wasm|woff2)/g)) named.add(m[0]);
    expect(named.size).toBeGreaterThan(8);
    for (const path of named) expect(existsSync(join(opts.build, path)), path).toBe(true);
    // The stylesheet that changed has a new name; the one that did not keeps its own.
    expect(html).toMatch(/\/assets\/signature-CCCC\.s[0-9a-f]{8}\.css/);
    expect(existsSync(join(opts.build, 'assets', 'main-FFFF.css'))).toBe(true);
    // The logo in an email is this site's, by its new name.
    const utils = everyText(opts.build).find(([f]) => /assets\/utils-BBBB\./.test(f))[1];
    expect(utils).toMatch(/\$\{window\.location\.origin\}\/assets\/logo-EEEE\.s[0-9a-f]{8}\.png/);
    // The ceremony script carries the wording it tells a closed document by.
    const ceremony = readFileSync(join(opts.build, 'assets', r.ceremony.js), 'utf8');
    expect(ceremony.startsWith('window.SCENTIC_STATE_WORDS={"declinedTitle":"Decline to sign"')).toBe(true);
    expect(JSON.parse(readFileSync(join(opts.build, 'locales', 'en', 'translation.json'), 'utf8'))['document-declined']).toBe('Decline to sign');

    expect(() => patchFrontend(opts)).toThrow();
  });

  it('a text font that is not the one expected is refused', () => {
    const opts = layOut({ timesBytes: 'some other font' });
    expect(() => patchFrontend(opts)).toThrow(/not the font/);
  });

  it.skipIf(!hasVendor)('a reference the transforms do not know is caught by the final check, by file and host', () => {
    const opts = layOut();
    writeFileSync(join(opts.build, 'assets', 'extra-GGGG.js'), 'fetch("https://cdn.jsdelivr.net/npm/left-pad");');
    expect(() => patchFrontend(opts)).toThrow(/still loaded from another host:\s+assets\/extra-GGGG\.s[0-9a-f]{8}\.js: cdn\.jsdelivr\.net/);
  });

  it.skipIf(!hasVendor)('a page built against another version of the PDF renderer is refused rather than given the wrong worker', () => {
    const opts = layOut();
    writeFileSync(join(opts.nodeModules, 'pdfjs-dist', 'package.json'), '{"version":"9.9.9"}');
    expect(() => patchFrontend(opts)).toThrow(/not built against pdfjs-dist 9\.9\.9/);
  });
});

describe.skipIf(!hasVendor)('the page source the transforms were written against (vendor/opensign)', () => {
  it('still loads from the hosts the patch removes, in the places the patch looks', () => {
    const read = rel => readFileSync(join(VENDOR_FRONTEND, rel), 'utf8');
    expect(read('index.html')).toContain('https://cdn.jsdelivr.net/npm/bootstrap@4.0.0/dist/css/bootstrap.min.css');
    expect(read('index.html')).toContain('https://cdn.opensignlabs.com/fonts.css');
    expect(read('src/styles/signature.css')).toContain('fonts.googleapis.com/css2?family=');
    expect(read('src/pages/GuestLogin.jsx')).toContain('alert(t("something-went-wrong-mssg"))');
    expect(read('src/pages/PdfRequestFiles.jsx')).toContain('alert(t("user-not-exist"))');
  });
});
