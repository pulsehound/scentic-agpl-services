// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The completion certificate as Scentic has it made — the event history, the documents of a
// request, the sending firm's name, the originator's address: OpenSign's real GenerateCertificate.js
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
import { PDFDocument, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyServerPatches } from '../opensign-server-patches.mjs';
import {
  clean,
  drawScenticEventHistory,
  drawScenticRelatedDocuments,
  eventRows,
  fitted,
  printable,
  relatedDocumentRows,
  scenticOrganization,
  utcStamp,
  visualOrder,
  wrapped,
} from '../opensign-server-files/scenticEventHistory.js';
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

const HEBREW_TITLE = 'הסכם שכר טרחה'; // "Fee agreement"
const HEBREW_TITLE_AS_DRAWN = Array.from(HEBREW_TITLE).reverse().join(''); // letters and spaces only
// Chrome inside an in-app browser on a Samsung phone, as such a string really arrives: 180 characters.
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; SM-S918BB Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 Instagram 337.0.0';
// The platform's one account owns every firm's documents; its company is not any firm's name.
const PLATFORM = 'Scentic Platform Ltd';
const FIRM = 'Cohen & Levi Law Offices';
const squeezed = text => text.replace(/\s+/g, '');
const outside = out => out.placed.filter(i => i.x < 15 || i.right > i.w - 15 || i.y < 15 || i.y > i.h - 15);
// The event history's last column starts four fifths of the way across the space between the margins.
const inBrowserColumn = item => Math.abs(item.x - (30 + (item.w - 60) * 0.8)) < 0.5;
const relatedList = (n, { hash = true, hebrewEvery = 0 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    total: n,
    title: hebrewEvery && (i + 1) % hebrewEvery === 0 ? HEBREW_TITLE : `Schedule ${String.fromCharCode(65 + (i % 26))}, part ${i + 1}`,
    ...(hash ? { sha256: (i + 16).toString(16).padStart(2, '0').repeat(32) } : {}),
  }));

/**
 * A certificate, and every string that was handed to the page to draw, in the order drawn.
 *
 * Reading a PDF back says what a reader's viewer makes of it, and pdf.js, like other viewers,
 * turns a right-to-left run inside a left-to-right line back into the order it was typed. What
 * was drawn, glyph after glyph from the left, is what the generator passed to drawText: that is
 * what the reading-order assertions look at.
 */
async function drawnBy(generate, doc) {
  const spy = vi.spyOn(PDFPage.prototype, 'drawText');
  try {
    const out = await textOf(await generate(doc));
    return { ...out, drawn: spy.mock.calls.map(call => call[0]) };
  } finally {
    spy.mockRestore();
  }
}

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

function fixtureDoc(scenticAudit, extra = {}) {
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
    ...extra,
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
    // The section starts on the page the signers ended on; every page after that one is headed.
    const first = pages.findIndex(page => page.includes('Event history'));
    expect(all.match(/Event history \(continued\)/g).length).toBe(count - 1 - first);
    for (const page of pages.slice(first)) expect(page).toContain('Time (UTC)');
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

  it('a Hebrew name is drawn, in reading order, in the event history', () => {
    expect(made.three.all).toContain(HEBREW_AS_DRAWN);
    expect(made.many.all).toContain(HEBREW_AS_DRAWN);
  });

  it('the browser string is printed whole, wrapped within its column; the row grows and the next row starts below it', async () => {
    expect(ANDROID.length).toBe(180);
    const out = await textOf(await generate(fixtureDoc([
      { at: '2026-11-19T08:00:00Z', event: 'Link opened', actor: 'Alice Example', email: 'alice@example.com', ipAddress: '203.0.113.7', userAgent: ANDROID },
      { at: '2026-11-19T08:01:00Z', event: 'Code verified', actor: 'Alice Example', userAgent: 'X'.repeat(600) },
      { at: '2026-11-19T08:02:00Z', event: 'Signed', actor: 'Alice Example', userAgent: 'short/1.0' },
    ])));
    // Every character of it, in order; before, the column showed its first 25 and "...".
    expect(squeezed(out.all)).toContain(squeezed(ANDROID));
    expect(squeezed(out.all)).toContain('Instagram337.0.0');
    // The fixture of the other tests too: the string that used to end "Chrome/126.0.0.0 Sa...".
    expect(squeezed(made.three.all)).toContain('Chrome/126.0.0.0Safari/537.36');
    // An unbroken string is broken where it stops fitting: 512 characters of it, the most kept.
    expect(out.all.match(/X/g)).toHaveLength(512);

    const column = out.placed.filter(inBrowserColumn);
    expect(column[0].str).toBe('Browser');
    // The column's name again at the head of each continued page; the rest are the strings' lines.
    const lines = column.filter(i => i.str !== 'Browser');
    expect(lines.some(i => i.str.endsWith('...'))).toBe(false);
    for (const item of lines) expect(item.right, item.str).toBeLessThanOrEqual(item.w - 30);
    const firstX = lines.findIndex(i => /^X+$/.test(i.str));
    const android = lines.slice(0, firstX);
    expect(android.length).toBeGreaterThanOrEqual(5);
    expect(squeezed(android.map(i => i.str).join(''))).toBe(squeezed(ANDROID));
    // One under another, never on top of each other, within a page.
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].page === lines[i - 1].page) expect(lines[i - 1].y - lines[i].y, lines[i].str).toBeGreaterThanOrEqual(7.9);
    }
    // The second row's own first line is below the first row's last browser line, and so on.
    const rowY = label => out.placed.find(i => i.str === label);
    const lowest = Math.min(...android.map(i => i.y));
    if (rowY('Code verified').page === android[0].page) expect(rowY('Code verified').y).toBeLessThan(lowest - 7.9);
    const lastX = lines.filter(i => /^X+$/.test(i.str)).pop();
    if (rowY('Signed').page === lastX.page) expect(rowY('Signed').y).toBeLessThan(lastX.y - 7.9);
    expect(outside(out)).toEqual([]);
  });

  it('five hundred events with long browser strings: every one whole, paginated, nothing outside the border', async () => {
    const audit = events(500).map((e, i) => ({ ...e, userAgent: `${ANDROID} #ua${i + 1}.` }));
    const out = await textOf(await generate(fixtureDoc(audit)));
    const text = squeezed(out.all);
    for (const i of [1, 2, 250, 499, 500]) expect(text, `ua ${i}`).toContain(squeezed(`${ANDROID} #ua${i}.`));
    expect(text.split(squeezed(ANDROID)).length - 1).toBe(500);
    expect(out.count).toBeGreaterThan(20);
    expect(outside(out)).toEqual([]);
    // Each continued page is headed, and no page is left with a heading and no row.
    for (const page of out.pages.slice(made.none.count)) expect(page).toMatch(/Event history \(continued\).*Mozilla/s);
  });

  it("the originator's address is printed where the certificate has always had a place for it", async () => {
    expect(squeezed(made.none.all)).toContain('IPaddress:1.Signer'); // as it was: blank
    for (const ip of ['198.51.100.24', '2001:db8::8a2e:370:7334']) {
      const out = await textOf(await generate(fixtureDoc(undefined, { OriginIp: ip, SenderName: 'Dana Levi', SenderMail: 'dana@cohenlevi.example' })));
      expect(squeezed(out.all)).toContain(squeezed(`Document originator Name : Dana Levi Email : dana@cohenlevi.example IP address : ${ip} 1. Signer`));
      expect(outside(out)).toEqual([]);
    }
  });

  it("Organization is the sending firm's name, never the platform's; the platform account's company only when the document names no firm", async () => {
    const platform = { Name: 'Scentic Admin', Email: 'admin@platform.example', Company: PLATFORM, Timezone: 'UTC', DateFormat: 'YYYY-MM-DD', Is12HourTime: false };
    const from = { SenderName: 'Dana Levi', SenderMail: 'dana@cohenlevi.example' };
    const organization = out => /Organization : (.*?) Created on :/.exec(out.all.replace(/\s+/g, ' '))[1];

    const firm = await textOf(await generate(fixtureDoc(events(3), { ExtUserPtr: platform, ...from, ScenticFirmName: FIRM, FirmName: 'An older name' })));
    expect(organization(firm)).toBe(FIRM);
    // Nowhere in the text of a firm's certificate: not the platform's company, not its name, not
    // the address of the platform's account. The originator is the sender, by name and address.
    expect(firm.all).not.toContain(PLATFORM);
    expect(firm.all).not.toMatch(/scentic/i);
    expect(firm.all).not.toContain('admin@platform.example');
    expect(firm.all).not.toMatch(/platform/i);
    expect(firm.all.replace(/\s+/g, ' ')).toContain('Document originator Name : Dana Levi Email : dana@cohenlevi.example IP address :');
    expect(outside(firm)).toEqual([]);

    // A document made before ScenticFirmName existed carries the firm as FirmName.
    const older = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, ...from, FirmName: FIRM })));
    expect(organization(older)).toBe(FIRM);
    expect(older.all).not.toContain(PLATFORM);

    // No firm on the document (one made on OpenSign's own page): what OpenSign printed before.
    for (const none of [{}, { ScenticFirmName: '', FirmName: '   ' }, { ScenticFirmName: 7, FirmName: { name: 'x' } }]) {
      const fallback = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, ...none })));
      expect(organization(fallback)).toBe(PLATFORM);
    }

    // A Hebrew firm is drawn in reading order; a name too long for the line is cut inside the border.
    const hebrew = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, ScenticFirmName: HEBREW_NAME })));
    expect(organization(hebrew)).toBe(HEBREW_AS_DRAWN);
    const long = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, ScenticFirmName: 'Cohen, Levi, Mizrahi & Partners '.repeat(9) })));
    expect(organization(long)).toMatch(/^Cohen, Levi, Mizrahi & Partners Cohen.*\.\.\.$/);
    expect(outside(long)).toEqual([]);
  });

  it("the originator's address is the sender's own when the document has one; the owning account's only when it has none; neither line leaves the border", async () => {
    const platform = { Name: 'Platform Admin', Email: 'admin@platform.example', Company: PLATFORM, Timezone: 'UTC', DateFormat: 'YYYY-MM-DD', Is12HourTime: false };
    const originator = out => /Document originator Name : (.*?) Email : (.*?) IP address :/.exec(out.all.replace(/\s+/g, ' ')).slice(1);

    const sent = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, SenderName: 'Dana Levi', SenderMail: 'dana.levi@cohenlevi.example' })));
    expect(originator(sent)).toEqual(['Dana Levi', 'dana.levi@cohenlevi.example']);
    expect(sent.all).not.toContain('admin@platform.example');
    expect(sent.all).not.toContain('Platform Admin');

    // A document made before the gateway wrote SenderMail: as OpenSign printed it.
    const before = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, SenderName: 'Dana Levi' })));
    expect(originator(before)).toEqual(['Dana Levi', 'admin@platform.example']);

    // The longest address the gateway takes, and a long name: cut inside the border, not drawn across it.
    const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(53)}.example`;
    const long = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, SenderName: 'Dana Levi of Cohen and Levi '.repeat(8), SenderMail: longest })));
    const [name, email] = originator(long);
    expect(name).toMatch(/^Dana Levi of Cohen and Levi Dana.*\.\.\.$/);
    expect(email).toMatch(/^a{64}@b+\.\.\.$/);
    expect(outside(long)).toEqual([]);
    // A Hebrew sender is drawn in reading order, like the signers.
    const hebrew = await textOf(await generate(fixtureDoc(undefined, { ExtUserPtr: platform, SenderName: HEBREW_NAME, SenderMail: 'yaakov@cohenlevi.example' })));
    expect(originator(hebrew)).toEqual([HEBREW_AS_DRAWN, 'yaakov@cohenlevi.example']);
  });

  it('documents in this request: absent, empty or not a list, the certificate is exactly the one it was', async () => {
    for (const value of [[], null, 'three', 7, { length: 2 }, [null, 'x', 3, [], {}, { title: '' }, { position: 0 }]]) {
      const out = await textOf(await generate(fixtureDoc(undefined, { ScenticRelatedDocuments: value })));
      expect(out.all, JSON.stringify(value)).not.toContain('Documents in this request');
      // Every item, at the place it was drawn before.
      expect(out.placed, JSON.stringify(value)).toEqual(made.none.placed);
    }
  });

  it('one document: listed after the summary and before the originator, marked as this document, with its hash', async () => {
    const hash = 'ab'.repeat(32);
    const out = await textOf(await generate(fixtureDoc(events(3), { ScenticRelatedDocuments: [{ position: 1, total: 1, title: 'Engagement letter', sha256: hash.toUpperCase(), current: true }] })));
    const flat = out.all.replace(/\s+/g, ' ');
    expect(flat).toContain(`Documents in this request 1 of 1 \u2014 Engagement letter (this document) SHA-256 : ${hash} Document originator`);
    expect(flat.indexOf('Signers : 2')).toBeLessThan(flat.indexOf('Documents in this request'));
    expect(flat.indexOf('Documents in this request')).toBeLessThan(flat.indexOf('Document originator'));
    expect(flat.indexOf('Document originator')).toBeLessThan(flat.indexOf('1. Signer'));
    expect(flat.indexOf('2. Signer')).toBeLessThan(flat.indexOf('Event history'));
    // Everything the certificate printed before is still there.
    for (const kept of ['Certificate of Completion', 'Engagement letter', 'alice@example.com', 'yaakov@example.co.il', '198.51.100.9', 'Code verified #3']) expect(out.all).toContain(kept);
    expect(outside(out)).toEqual([]);
  });

  it('three documents, one with a Hebrew title: in the order given, the Hebrew in reading order, only the current one marked', async () => {
    const list = [
      { position: 1, total: 3, title: 'Engagement letter', sha256: '11'.repeat(32) },
      { position: 2, total: 3, title: HEBREW_TITLE, current: true },
      { position: 3, total: 3, title: 'Power of attorney', sha256: '33'.repeat(32) },
    ];
    const out = await drawnBy(generate, fixtureDoc(undefined, { ScenticRelatedDocuments: list, OriginIp: '198.51.100.24' }));
    // What was drawn, in order: the Hebrew letters from the left in reading order.
    const from = out.drawn.indexOf('Documents in this request');
    expect(out.drawn.slice(from, out.drawn.indexOf('Document originator') + 1)).toEqual([
      'Documents in this request',
      '1 of 3 \u2014 Engagement letter',
      `SHA-256 : ${'11'.repeat(32)}`,
      `2 of 3 \u2014 ${HEBREW_TITLE_AS_DRAWN} (this document)`,
      '3 of 3 \u2014 Power of attorney',
      `SHA-256 : ${'33'.repeat(32)}`,
      'Document originator',
    ]);
    expect(out.drawn.some(text => text.includes(HEBREW_TITLE))).toBe(false); // never in the order it was typed
    // What a reader's viewer gives back for the same lines: the title as it was typed.
    const flat = out.all.replace(/\s+/g, ' ');
    expect(flat).toContain(
      `Documents in this request 1 of 3 \u2014 Engagement letter SHA-256 : ${'11'.repeat(32)} ` +
        `2 of 3 \u2014 ${HEBREW_TITLE} (this document) ` +
        `3 of 3 \u2014 Power of attorney SHA-256 : ${'33'.repeat(32)} Document originator`,
    );
    expect(flat.match(/\(this document\)/g)).toHaveLength(1);
    expect(squeezed(out.all)).toContain('IPaddress:198.51.100.241.Signer');
    // Both signers still follow, whole.
    for (const kept of ['1. Signer', '2. Signer', 'alice@example.com', 'yaakov@example.co.il', '198.51.100.9']) expect(out.all).toContain(kept);
    expect(outside(out)).toEqual([]);
  });

  it('forty documents with hashes, every fifth title Hebrew: all listed over continued pages, the originator and signers whole after them', async () => {
    const list = relatedList(40, { hebrewEvery: 5 }).map(d => (d.position === 17 ? { ...d, current: true } : d));
    const out = await drawnBy(generate, fixtureDoc(events(3), { ScenticRelatedDocuments: list, OriginIp: '198.51.100.24', SenderName: 'Dana Levi', SenderMail: 'dana@cohenlevi.example' }));
    // Drawn: every entry and then its hash, in the order given, a continued page's heading between some.
    const section = out.drawn.slice(out.drawn.indexOf('Documents in this request') + 1, out.drawn.indexOf('Document originator')).filter(text => text !== 'Documents in this request (continued)');
    expect(section).toEqual(list.flatMap(d => [
      `${d.position} of 40 \u2014 ${d.title === HEBREW_TITLE ? HEBREW_TITLE_AS_DRAWN : d.title}${d.current ? ' (this document)' : ''}`,
      `SHA-256 : ${d.sha256}`,
    ]));
    expect(list.filter(d => d.title === HEBREW_TITLE)).toHaveLength(8);
    // Read back from the PDF: each entry and each hash, in order. (A line that is mostly Hebrew is
    // read back by the viewer as a right-to-left line, digits and all: for those only the hash
    // beneath is looked for here; the line itself is among the drawn ones above.)
    const flat = out.all.replace(/\s+/g, ' ');
    let at = flat.indexOf('Documents in this request');
    for (const d of list) {
      for (const part of [...(d.title === HEBREW_TITLE ? [] : [`${d.position} of 40 \u2014 ${d.title}`]), `SHA-256 : ${d.sha256}`]) {
        const found = flat.indexOf(part, at);
        expect(found, `${d.position}: ${part}`).toBeGreaterThan(-1);
        at = found;
      }
    }
    expect(flat.match(/\(this document\)/g)).toHaveLength(1);
    // Forty lines drawn (above); thirty-two of them read back left to right, the eight Hebrew ones not.
    expect(flat.match(/ of 40 \u2014 /g)).toHaveLength(32);
    expect(out.count).toBeGreaterThan(made.three.count);
    expect(flat.match(/Documents in this request \(continued\)/g).length).toBeGreaterThanOrEqual(1);
    // The originator block is on one page, whole, after the last entry.
    const originatorPage = out.pages.find(page => page.includes('Document originator')).replace(/\s+/g, ' ');
    expect(originatorPage).toContain('Document originator Name : Dana Levi Email : dana@cohenlevi.example IP address : 198.51.100.24');
    expect(flat.indexOf('40 of 40')).toBeLessThan(flat.indexOf('Document originator'));
    expect(flat.indexOf('Document originator')).toBeLessThan(flat.indexOf('1. Signer'));
    expect(flat.indexOf('1. Signer')).toBeLessThan(flat.indexOf('2. Signer'));
    expect(flat.indexOf('2. Signer')).toBeLessThan(flat.indexOf('Event history'));
    expect(flat).toContain('Code verified #3');
    expect(outside(out)).toEqual([]);
    // No two lines of the list on top of each other.
    const start = out.placed.findIndex(i => i.str.startsWith('Documents in this request'));
    const end = out.placed.findIndex(i => i.str === 'Document originator');
    const rows = out.placed.slice(start, end);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].page === rows[i - 1].page) expect(rows[i - 1].y - rows[i].y, rows[i].str).toBeGreaterThanOrEqual(11.9);
    }
  });

  it('every length of list from 1 to 50, with and without hashes: nothing outside the border, the originator never split across pages', async () => {
    for (let n = 1; n <= 50; n++) {
      const out = await textOf(await generate(fixtureDoc(undefined, { ScenticRelatedDocuments: relatedList(n, { hash: n % 2 === 0 }), OriginIp: '198.51.100.24' })));
      expect(outside(out), `${n} documents`).toEqual([]);
      expect(out.all.match(/ of \d+ \u2014 /g), `${n} documents`).toHaveLength(n);
      const page = out.pages.find(p => p.includes('Document originator')).replace(/\s+/g, '');
      expect(page, `${n} documents`).toMatch(/Documentoriginator.*IPaddress:198\.51\.100\.24/);
      for (const signer of ['1. Signer', '2. Signer']) expect(out.all, `${n} documents`).toContain(signer);
    }
  });

  it('a title as long as is allowed is wrapped, not cut; more than fifty entries, or odd ones, never stop the certificate', async () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ').slice(0, 300);
    const out = await textOf(await generate(fixtureDoc(undefined, { ScenticRelatedDocuments: [{ position: 2, total: 2, title: words, current: true }] })));
    expect(squeezed(out.all)).toContain(squeezed(`2 of 2 \u2014 ${words} (this document)`));
    expect(outside(out)).toEqual([]);

    const odd = [null, 'x', { position: 1, total: 2, title: 'Emoji \u{1F600} and 中文', sha256: 'not a hash' }, { title: 'No place' }, { position: 2, total: 0, title: 'Tab\tand\nnewline' }, ...relatedList(60)];
    const many = await textOf(await generate(fixtureDoc(undefined, { ScenticRelatedDocuments: odd })));
    const flat = many.all.replace(/\s+/g, ' ');
    expect(flat).toContain('1 of 2 \u2014 Emoji ? and ?? No place 2 \u2014 Tab and newline 1 of 60 \u2014');
    expect(flat).not.toContain('not a hash');
    // Fifty entries of the list as stored are read, whatever they are.
    expect(flat).toContain('45 of 60');
    expect(flat).not.toContain('46 of 60');
    expect(many.all).toContain('Certificate of Completion');
    expect(outside(many)).toEqual([]);
  });

  it('each signer is named as they confirmed for this document, not as the shared contact has them; Hebrew in reading order', async () => {
    // The document of a second firm: OpenSign's one contact for the address still carries the name
    // the first firm gave it.
    const doc = fixtureDoc([{ at: '2026-11-19T08:20:00Z', event: 'Signed', actor: '', email: 'alice@example.com' }]);
    doc.Signers[0].Name = 'Alice A';
    const stored = await textOf(await generate(doc));
    expect(stored.all).toContain('Alice A');
    expect(stored.all).toContain(HEBREW_NAME); // as before: the contact's name, in the order it was typed

    doc.ScenticSignerNames = [
      { email: 'Alice@Example.com', name: 'Robert B' },
      { email: 'yaakov@example.co.il', name: HEBREW_NAME },
    ];
    const confirmed = await textOf(await generate(doc));
    expect(confirmed.all).toContain('Robert B');
    expect(confirmed.all).not.toContain('Alice A');
    expect(confirmed.all).toContain(HEBREW_AS_DRAWN);
    expect(confirmed.all).not.toContain(HEBREW_NAME);
    // In the signer's block, and in the event history where the record gave only an address.
    expect(confirmed.all.match(/Robert B/g).length).toBe(2);
    // A name confirmed by one signer names nobody else, and what is not a name entry is passed over.
    doc.ScenticSignerNames = [null, 'x', { email: 'yaakov@example.co.il' }, { email: 'someone@else.com', name: 'Mallory' }];
    const others = await textOf(await generate(doc));
    expect(others.all).toContain('Alice A');
    expect(others.all).not.toContain('Mallory');
  });

  it('a signer replaced or who passed it on is not printed as a signer: no nameless block "signed" when the certificate was made (round 76)', async () => {
    const doc = fixtureDoc([{ at: '2026-11-19T08:05:00Z', event: 'Passed to another signer', actor: 'Tess Earlier', email: 'tess@example.com', detail: 'Our CFO signs' }]);
    // OpenSign after a replacement: the earlier person's view stays in AuditTrail, and they are no longer among Signers.
    const tess = { objectId: 'c0', Name: 'Tess Earlier', Email: 'tess@example.com', className: 'contracts_Contactbook', __type: 'Object' };
    doc.AuditTrail = [{ UserPtr: tess, Activity: 'Viewed', ipAddress: '192.0.2.44', ViewedOn: '2026-11-19T08:01:00.000Z' }, ...doc.AuditTrail];
    const made = await textOf(await generate(doc));
    // Two signer blocks, the two who signed; the earlier person's view and address are not among them.
    expect(made.all.match(/\d\. Signer/g)).toEqual(['1. Signer', '2. Signer']);
    expect(made.all).not.toContain('192.0.2.44');
    expect(made.all).toContain('alice@example.com');
    expect(made.all).toContain('yaakov@example.co.il');
    // Scentic's own history still says who passed it on.
    expect(made.all).toContain('Passed to another signer');
    expect(made.all).toContain('Tess Earlier');
    // Without the filter the earlier person would have been printed: the same document with them among Signers shows them.
    doc.Signers = [tess, ...doc.Signers];
    expect((await textOf(await generate(doc))).all).toContain('192.0.2.44');
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
    expect(drawScenticRelatedDocuments({ pdfDoc: pdf, font, documents: [], page, y: 400 })).toBeNull();
    expect(drawScenticRelatedDocuments({ pdfDoc: pdf, font, documents: undefined, page, y: 400 })).toBeNull();
    expect(pdf.getPageCount()).toBe(1);
  });

  it('text is wrapped to a width with nothing left out: at spaces, and inside a word only when the word alone is too wide', () => {
    const lines = wrapped(font, ANDROID, 7, 101);
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 7), line).toBeLessThanOrEqual(101);
    expect(lines.join(' ')).toBe(ANDROID); // these words all fit: broken only at spaces
    const unbroken = 'A'.repeat(200);
    const pieces = wrapped(font, unbroken, 7, 101);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(font.widthOfTextAtSize(piece, 7)).toBeLessThanOrEqual(101);
    expect(pieces.join('')).toBe(unbroken);
    expect(wrapped(font, 'short', 7, 101)).toEqual(['short']);
    expect(wrapped(font, '', 7, 101)).toEqual([]);
    expect(wrapped(font, 'wide', 7, 0.1)).toEqual(['w', 'i', 'd', 'e']);
  });

  it('a right-to-left title wraps from its first words down, each line in reading order', () => {
    const title = Array.from({ length: 12 }, () => HEBREW_TITLE).join(' ');
    const lines = wrapped(font, title, 12, 200);
    expect(lines.length).toBeGreaterThan(1);
    // Read each line right to left and the lines top to bottom: the title as it was typed.
    expect(lines.map(line => Array.from(line).reverse().join('')).join(' ')).toBe(title);
  });

  it('a browser string keeps 512 characters, other text 300, in the order typed until it is drawn', () => {
    expect(clean(font, 'x'.repeat(900))).toHaveLength(300);
    expect(eventRows(font, [{ at: '2026-11-19T08:00:00Z', event: 'e', actor: 'a', userAgent: 'u'.repeat(900) }])[0].browser).toHaveLength(512);
    expect(clean(font, HEBREW_NAME)).toBe(HEBREW_NAME);
    expect(printable(font, HEBREW_NAME)).toBe(HEBREW_AS_DRAWN);
  });

  it('the documents of a request: at most fifty, in the order given, the current one marked, a hash only when it is one', () => {
    const rows = relatedDocumentRows(font, [
      { position: 2, total: 3, title: 'B', current: true, sha256: 'AB'.repeat(32) },
      { position: 1, total: 3, title: 'A', current: 'yes', sha256: 'zz' },
    ]);
    expect(rows).toEqual([
      { text: '2 of 3 \u2014 B (this document)', sha: 'ab'.repeat(32) },
      { text: '1 of 3 \u2014 A', sha: '' },
    ]);
    expect(relatedDocumentRows(font, relatedList(80))).toHaveLength(50);
    expect(relatedDocumentRows(font, 'nope')).toEqual([]);
  });

  it("the organization is the document's firm, then its older field, then what it was", () => {
    expect(scenticOrganization({ ScenticFirmName: FIRM, FirmName: 'Older' }, PLATFORM, font, 400)).toBe(FIRM);
    expect(scenticOrganization({ FirmName: FIRM }, PLATFORM, font, 400)).toBe(FIRM);
    expect(scenticOrganization({ ScenticFirmName: ' ' }, PLATFORM, font, 400)).toBe(PLATFORM);
    expect(scenticOrganization(undefined, PLATFORM, font, 400)).toBe(PLATFORM);
    expect(scenticOrganization({ ScenticFirmName: HEBREW_NAME }, PLATFORM, font, 400)).toBe(HEBREW_AS_DRAWN);
    const cut = scenticOrganization({ ScenticFirmName: 'Long name '.repeat(30) }, PLATFORM, font, 400);
    expect(cut.endsWith('...')).toBe(true);
    expect(font.widthOfTextAtSize(cut, 13)).toBeLessThanOrEqual(400);
  });
});
