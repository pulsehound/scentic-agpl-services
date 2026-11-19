// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The completion certificate with Scentic's event history: OpenSign's real GenerateCertificate.js
// (vendor/opensign), patched by deploy/opensign-server-patches.mjs, run in Node on fixture
// documents; the PDFs it makes are read back with pdf.js and their text asserted.
//
// What is real: the generator's source, the patch, pdf-lib and fontkit at the versions the server
// pins, the server's own font and images. What is stood in for: the server's Utils.js, which the
// generator imports one function from (formatDateTime) and which cannot be loaded without the whole
// server installed. The stand-in below is that function with the two helpers it calls, built on the
// same date-fns-tz calls; it formats the dates upstream's certificate already printed and plays no
// part in the event history. A run inside the server image, with the real Utils.js, is the proof
// for that seam (README, "Tests").
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyServerPatches } from '../opensign-server-patches.mjs';
import { drawScenticEventHistory, eventRows, fitted, printable, utcStamp, visualOrder } from '../opensign-server-files/scenticEventHistory.js';
import { DEPLOY, NO_VENDOR, SERVER_FILES, VENDOR_SERVER, copyOfVendoredServer, hasVendor } from './helpers.mjs';

const UTILS_STAND_IN = `
import { format, toZonedTime } from 'date-fns-tz';
function selectFormat(dateFormat) {
  return { 'MM/DD/YYYY': 'MM/dd/yyyy', 'DD-MM-YYYY': 'dd-MM-yyyy', 'DD/MM/YYYY': 'dd/MM/yyyy', 'YYYY-MM-DD': 'yyyy-MM-dd' }[dateFormat] || 'MM/dd/yyyy';
}
export function formatDateTime(date, dateFormat, timeZone, is12Hour) {
  const zone = timeZone || 'UTC';
  const zonedDate = toZonedTime(date, zone);
  const timeFormat = is12Hour ? 'hh:mm:ss a' : 'HH:mm:ss';
  return format(zonedDate, \`\${selectFormat(dateFormat)}, \${timeFormat} 'GMT' XXX\`, { timeZone: zone });
}
`;

const HEBREW_NAME = 'יעקב כהן'; // "Yaakov Cohen", in the order it is typed
const HEBREW_AS_DRAWN = 'ןהכ בקעי'; // the same letters in reading order, left to right

async function textOf(bytes) {
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map(i => i.str).join(' '));
  }
  // Every drawn item with where it was drawn, for the overflow checks.
  const placed = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [, , w, h] = page.view;
    for (const item of (await page.getTextContent()).items) {
      if (item.str.trim()) placed.push({ page: n, x: item.transform[4], y: item.transform[5], right: item.transform[4] + item.width, str: item.str, w, h });
    }
  }
  await pdf.destroy();
  return { pages, all: pages.join('\n'), count: pages.length, placed };
}

function events(n) {
  const kinds = ['Link opened', 'Code sent', 'Code verified', 'Document viewed', 'Signed'];
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(Date.UTC(2026, 10, 19, 8, 0, 0) + i * 61_000).toISOString(),
    event: `${kinds[i % kinds.length]} #${i + 1}`,
    actor: i % 2 === 0 ? 'Alice Example' : HEBREW_NAME,
    email: i % 2 === 0 ? 'alice@example.com' : 'yaakov@example.co.il',
    ipAddress: i % 3 === 0 ? '2001:0db8:85a3:0000:0000:8a2e:0370:7334' : '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ...(i % 7 === 0 ? { detail: 'Signature drawn' } : {}),
  }));
}

function fixtureDoc(scenticAudit) {
  const contact = (id, name, email) => ({ objectId: id, Name: name, Email: email, className: 'contracts_Contactbook', __type: 'Object' });
  const alice = contact('c1', 'Alice Example', 'alice@example.com');
  const yaakov = contact('c2', HEBREW_NAME, 'yaakov@example.co.il');
  return {
    objectId: 'doc123',
    Name: 'Engagement letter',
    createdAt: '2026-11-18T10:00:00.000Z',
    completedAt: '2026-11-19T09:30:00.000Z',
    DocumentHash: 'ab'.repeat(32),
    IsEnableOTP: true,
    ExtUserPtr: { Name: 'Acme Law', Email: 'firm@example.com', Company: 'Acme Law', Timezone: 'UTC', DateFormat: 'YYYY-MM-DD', Is12HourTime: false },
    Signers: [alice, yaakov],
    Placeholders: [
      { Role: 'signer', email: alice.Email, signerObjId: 'c1', signerPtr: alice },
      { Role: 'signer', email: yaakov.Email, signerObjId: 'c2', signerPtr: yaakov },
    ],
    AuditTrail: [
      { UserPtr: alice, Activity: 'Signed', ipAddress: '203.0.113.7', ViewedOn: '2026-11-19T08:10:00.000Z', SignedOn: '2026-11-19T08:20:00.000Z' },
      { UserPtr: yaakov, Activity: 'Signed', ipAddress: '198.51.100.9', ViewedOn: '2026-11-19T09:10:00.000Z', SignedOn: '2026-11-19T09:30:00.000Z' },
    ],
    ...(scenticAudit === undefined ? {} : { ScenticAudit: scenticAudit }),
  };
}

describe.skipIf(!hasVendor)(`the certificate, from the patched upstream generator${hasVendor ? '' : ` — SKIPPED: ${NO_VENDOR}`}`, () => {
  let root;
  let generate;
  let cwd;
  const made = {};

  beforeAll(async () => {
    // Inside this package, so the generator's imports (pdf-lib, fontkit) resolve to what is installed here.
    root = join(DEPLOY, 'tests', '.certificate-run');
    rmSync(root, { recursive: true, force: true });
    const copy = copyOfVendoredServer();
    mkdirSync(root, { recursive: true });
    applyServerPatches({ root: copy, filesDir: SERVER_FILES });
    for (const rel of ['cloud/parsefunction/pdf/GenerateCertificate.js', 'cloud/parsefunction/pdf/scenticEventHistory.js']) {
      mkdirSync(join(root, 'cloud', 'parsefunction', 'pdf'), { recursive: true });
      writeFileSync(join(root, rel), readFileSync(join(copy, rel)));
    }
    for (const rel of ['font/times.ttf', 'images/logo.png', 'images/na_sign.png']) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), readFileSync(join(VENDOR_SERVER, rel)));
    }
    // The image carries Scentic's mark in place of upstream's (Dockerfile.opensign-server).
    writeFileSync(join(root, 'images', 'logo.png'), readFileSync(join(DEPLOY, 'opensign-assets', 'logo.png')));
    writeFileSync(join(root, 'Utils.js'), UTILS_STAND_IN);
    rmSync(copy, { recursive: true, force: true });
    // The generator reads ./font and ./images from the server's working directory.
    cwd = process.cwd();
    process.chdir(root);
    generate = (await import(pathToFileURL(join(root, 'cloud', 'parsefunction', 'pdf', 'GenerateCertificate.js')).href)).default;
    for (const [name, audit] of [['none', undefined], ['empty', []], ['three', events(3)], ['many', events(120)]]) {
      made[name] = await textOf(await generate(fixtureDoc(audit)));
    }
  });
  afterAll(() => {
    if (cwd) process.chdir(cwd);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('with no record, or an empty one, the certificate is the one it was: one page, the signers, no event history', () => {
    for (const name of ['none', 'empty']) {
      expect(made[name].count, name).toBe(1);
      expect(made[name].all, name).not.toContain('Event history');
      expect(made[name].all, name).toContain('Certificate of Completion');
      expect(made[name].all, name).toContain('alice@example.com');
      expect(made[name].all, name).toContain('yaakov@example.co.il');
    }
    expect(made.empty.all).toBe(made.none.all);
  });

  it('three events: a section after the signers with a row for each, in time order', () => {
    const { all, pages } = made.three;
    expect(all).toContain('Event history');
    for (const label of ['Time (UTC)', 'Event', 'Who', 'IP address', 'Browser']) expect(all).toContain(label);
    for (const [i, stamp] of ['2026-11-19 08:00:00 UTC', '2026-11-19 08:01:01 UTC', '2026-11-19 08:02:02 UTC'].entries()) {
      expect(all).toContain(stamp);
      expect(all).toContain(`#${i + 1}`);
    }
    expect(all.indexOf('Link opened #1')).toBeLessThan(all.indexOf('Code sent #2'));
    expect(all.indexOf('Code sent #2')).toBeLessThan(all.indexOf('Code verified #3'));
    expect(all).toContain('203.0.113.7');
    expect(all).toContain('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(all).toContain('Mozilla/5.0');
    expect(all).toContain('Signature drawn');
    // Everything the certificate printed before is still there, before the new section.
    for (const kept of ['Certificate of Completion', 'Engagement letter', 'alice@example.com', '198.51.100.9']) expect(all).toContain(kept);
    const last = pages[pages.length - 1];
    expect(pages.join('\n').indexOf('198.51.100.9')).toBeLessThan(pages.join('\n').indexOf('Event history'));
    expect(last).toContain('Code verified #3');
  });

  it('120 events: every row is there, over more pages, each continued page headed', () => {
    const { all, count, pages } = made.many;
    expect(count).toBeGreaterThan(made.three.count);
    expect(count).toBeGreaterThanOrEqual(3);
    for (let i = 1; i <= 120; i++) expect(all, `event ${i}`).toMatch(new RegExp(`#${i}(?!\\d)`));
    expect(all.match(/Event history \(continued\)/g).length).toBe(count - made.three.count);
    for (const page of pages.slice(made.three.count)) expect(page).toContain('Time (UTC)');
    expect(all.indexOf('#119')).toBeLessThan(all.indexOf('#120'));
  });

  it('nothing is drawn outside the page border, on any page, however many events', () => {
    for (const name of ['three', 'many']) {
      for (const item of made[name].placed) {
        expect(item.x, `${name} p${item.page} "${item.str}"`).toBeGreaterThanOrEqual(15);
        expect(item.right, `${name} p${item.page} "${item.str}"`).toBeLessThanOrEqual(item.w - 15);
        expect(item.y, `${name} p${item.page} "${item.str}"`).toBeGreaterThanOrEqual(15);
        expect(item.y, `${name} p${item.page} "${item.str}"`).toBeLessThanOrEqual(item.h - 15);
      }
    }
  });

  it('a Hebrew name is drawn, in reading order, in the event history; a long browser string is cut to its column', () => {
    expect(made.three.all).toContain(HEBREW_AS_DRAWN);
    expect(made.many.all).toContain(HEBREW_AS_DRAWN);
    expect(made.three.all).toContain('...');
    expect(made.three.all).not.toContain('Safari/537.36');
  });

  it('a record that is not what it should be never stops the certificate', async () => {
    const odd = [
      null,
      'a string',
      42,
      { at: 'not a date', event: 'Odd time', actor: 'X' },
      { at: '2026-11-19T08:00:00Z', event: 'Emoji \u{1F600} and 中文', actor: 'Tab\tand\nnewline', userAgent: 'x'.repeat(5000), ipAddress: {} },
      { at: '2026-11-19T07:00:00Z', event: '‮Reversed', actor: '' },
      {},
    ];
    for (const audit of [odd, 'not an array', { length: 3 }, 7]) {
      const out = await textOf(await generate(fixtureDoc(audit)));
      expect(out.all).toContain('Certificate of Completion');
    }
    const out = await textOf(await generate(fixtureDoc(odd)));
    expect(out.all).toContain('Odd time');
    expect(out.all).toContain('Emoji ? and ??');
    expect(out.all).toContain('Tab and newline');
    expect(out.all).toContain('Reversed');
    // Dated events first, in order; the undated one last.
    expect(out.all.indexOf('Reversed')).toBeLessThan(out.all.indexOf('Emoji'));
    expect(out.all.indexOf('Emoji')).toBeLessThan(out.all.indexOf('Odd time'));
  });
});

describe.skipIf(!hasVendor)('the event history helpers, with the certificate font', () => {
  let font;
  beforeAll(async () => {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    font = await pdf.embedFont(readFileSync(join(VENDOR_SERVER, 'font', 'times.ttf')), { subset: true });
  });

  it('the certificate font has the Hebrew letters; it has no Chinese or emoji, which become "?"', () => {
    const set = new Set(font.getCharacterSet());
    for (let code = 0x05d0; code <= 0x05ea; code++) expect(set.has(code), `U+${code.toString(16)}`).toBe(true);
    expect(set.has(0x4e2d)).toBe(false);
    expect(printable(font, '中文 ok \u{1F600}')).toBe('?? ok ?');
  });

  it('times are UTC, to the second', () => {
    expect(utcStamp('2026-11-19T10:05:07+02:00')).toBe('2026-11-19 08:05:07 UTC');
    expect(utcStamp({ __type: 'Date', iso: '2026-01-02T03:04:05.678Z' })).toBe('2026-01-02 03:04:05 UTC');
    expect(utcStamp('nonsense')).toBe('');
    expect(utcStamp(undefined)).toBe('');
  });

  it('right-to-left runs are put in reading order; Latin and digits are left alone', () => {
    expect(visualOrder(HEBREW_NAME)).toBe(HEBREW_AS_DRAWN);
    expect(visualOrder('Signed by ' + HEBREW_NAME + ' (CEO)')).toBe('Signed by ' + HEBREW_AS_DRAWN + ' (CEO)');
    expect(visualOrder('plain 123')).toBe('plain 123');
    expect(visualOrder('')).toBe('');
  });

  it('text is cut to a width, never past it', () => {
    const long = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const cut = fitted(font, long, 8, 100);
    expect(cut.endsWith('...')).toBe(true);
    expect(font.widthOfTextAtSize(cut, 8)).toBeLessThanOrEqual(100);
    expect(fitted(font, 'short', 8, 100)).toBe('short');
    expect(fitted(font, long, 8, 1)).toBe('');
  });

  it('at most 500 events are printed, and what is not an event is passed over', () => {
    expect(eventRows(font, Array.from({ length: 700 }, (_, i) => ({ at: '2026-11-19T08:00:00Z', event: `e${i}`, actor: 'a' })))).toHaveLength(500);
    expect(eventRows(font, [null, 3, 'x', [], {}])).toEqual([]);
    expect(eventRows(font, undefined)).toEqual([]);
  });

  it('with nothing to print it draws nothing and adds no page', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage();
    expect(drawScenticEventHistory({ pdfDoc: pdf, font, events: [], page, y: 400 })).toBe(0);
    expect(pdf.getPageCount()).toBe(1);
  });
});
