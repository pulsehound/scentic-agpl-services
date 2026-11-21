// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What Scentic adds to the completion certificate: the "Event history" section, the "Documents in
// this request" section, the signer's confirmed name and the sending firm's name.
//
// The "Event history" section of the completion certificate. Added to OpenSign's
// cloud/parsefunction/pdf/ at image build and called from its GenerateCertificate.js
// (deploy/opensign-server-patches.mjs).
//
// OpenSign's certificate lists each signer once: when they viewed, when they signed, from where.
// Where Scentic hosts the signing ceremony it keeps a fuller record — the link opened, the code
// sent and verified, each document view, each signature or refusal, with time, address and
// browser — and hands it to the gateway with each signature (the document's `ScenticAudit`). This
// prints that record after the signers, one row per event in time order, over as many pages as it
// takes. Nothing the certificate printed before is moved or removed; a document with no
// `ScenticAudit` gets exactly the certificate it got before.
//
// The same holds for the other two things drawn from here. "Documents in this request" (the
// document's `ScenticRelatedDocuments`: the documents sent together in one request, this one
// marked) is printed between the summary and the originator only when the document has that list.
// "Organization" prints the firm that sent the document (`ScenticFirmName`, or `FirmName` on a
// document made before that field existed), not the company of the one platform account that
// owns every firm's documents.
//
// It must never be the reason a certificate is not made: whatever is in the record, it is reduced
// to text the certificate's font can draw, and anything that is not an event is passed over.
import { PDFHexString, rgb } from 'pdf-lib';

const MAX_EVENTS = 500;
const MAX_TEXT = 300;
// A browser's own description of itself (User-Agent): the gateway keeps up to 512 characters.
const MAX_BROWSER = 512;
const MAX_DOCUMENTS = 50;

const pad = n => String(n).padStart(2, '0');

/** A time as `YYYY-MM-DD HH:mm:ss UTC`, or '' when it is not a time. */
export function utcStamp(value) {
  const raw = value && typeof value === 'object' && value.iso ? value.iso : value;
  const date = raw instanceof Date ? raw : new Date(typeof raw === 'string' || typeof raw === 'number' ? raw : NaN);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
  );
}

const isRtl = code =>
  (code >= 0x0590 && code <= 0x08ff) || (code >= 0xfb1d && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff);
// What may sit inside a right-to-left phrase without ending it: spaces and plain punctuation.
const isNeutral = ch => /^[\s.,;:!?'"()\-–—/\\]$/.test(ch);

/**
 * Right-to-left runs put in the order they are seen, left to right, for a page that lays glyphs out
 * only left to right. Each run of Hebrew or Arabic letters, with the spaces and punctuation between
 * them, is reversed in place; Latin text and digits stay as they are. This is not the Unicode
 * bidirectional algorithm: a line mixing both directions keeps the order of its runs (the
 * certificate is a left-to-right page), and Arabic letters are drawn unjoined.
 */
export function visualOrder(text) {
  const chars = Array.from(text);
  const out = [];
  let i = 0;
  while (i < chars.length) {
    if (!isRtl(chars[i].codePointAt(0))) {
      out.push(chars[i++]);
      continue;
    }
    let end = i;
    for (let j = i; j < chars.length; j++) {
      if (isRtl(chars[j].codePointAt(0))) end = j;
      else if (!isNeutral(chars[j])) break;
    }
    const run = chars.slice(i, end + 1).reverse().map(ch => ({ '(': ')', ')': '(' })[ch] ?? ch);
    out.push(...run);
    i = end + 1;
  }
  return out.join('');
}

const hasRtl = text => Array.from(text).some(ch => isRtl(ch.codePointAt(0)));
const IN_READING_ORDER = Symbol.for('scentic.certificate.readingOrder');

/**
 * Make `font` draw right-to-left text the way a reader of it reads it, and so that copying it,
 * searching it and extracting it give it back in the order it was typed (F-19).
 *
 * Every string handed to pdf-lib's drawText with this font is in the order it was typed. The font's
 * encodeText, which drawText calls once a line, is replaced for this font only: a string with a
 * right-to-left letter in it is put in visual order (`visualOrder`) and each character is encoded
 * on its own, so the glyphs are written to the page in the order they are seen, left to right.
 * Readers (pdf.js, PDFium, MuPDF, Xpdf) find a right-to-left run written that way and turn it back
 * into the typed order, as they do for any PDF made by a word processor.
 *
 * Why not leave it to pdf-lib: its shaper (fontkit) reverses a whole string when the string's first
 * letter is Hebrew or Arabic, and leaves it alone otherwise. Strings put in visual order first were
 * reversed back (a confirmed Hebrew name, a Hebrew firm name, the originator's Hebrew name and the
 * event history's Hebrew names were drawn backwards, and read back backwards); strings left as typed
 * were right only when they began with a Hebrew letter. Encoding each character alone gives the
 * shaper nothing to reorder. Text with no right-to-left letter is encoded as before, whole.
 *
 * Why not /ActualText (a marked span carrying the typed text): pdf.js ignores it, and PDFium and
 * MuPDF read it and then reverse it again, so it helps Acrobat alone and harms two others.
 */
export function scenticReadingOrder(font) {
  if (!font || typeof font.encodeText !== 'function' || font[IN_READING_ORDER]) return font;
  const encode = font.encodeText.bind(font);
  font.encodeText = text => {
    const value = String(text ?? '');
    if (!hasRtl(value)) return encode(value);
    let hex = '';
    for (const ch of visualOrder(value)) hex += encode(ch).toString().slice(1, -1);
    return PDFHexString.of(hex);
  };
  font[IN_READING_ORDER] = true;
  return font;
}

const glyphSets = new WeakMap();
function glyphs(font) {
  let set = glyphSets.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    glyphSets.set(font, set);
  }
  return set;
}

/**
 * Text the font can draw, on one line, in the order it was typed: control characters and line
 * breaks become spaces, marks that reorder text are dropped, and a character the font has no glyph
 * for becomes "?". At most `max` characters.
 */
export function clean(font, value, max = MAX_TEXT) {
  if (value === null || value === undefined) return '';
  const have = glyphs(font);
  let out = '';
  for (const ch of Array.from(String(value)).slice(0, max)) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) out += ' ';
    else if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) continue;
    else out += have.has(code) ? ch : '?';
  }
  return out.replace(/ +/g, ' ').trim();
}

/**
 * `clean` text, ready to draw on one line with a font made by `scenticReadingOrder`, which puts its
 * right-to-left runs in visual order as it draws them. Kept in the order it was typed.
 */
export function printable(font, value, max = MAX_TEXT) {
  return clean(font, value, max);
}

/**
 * `clean` text as lines no wider than `width` at `size`, nothing left out. A line breaks at a
 * space; a single word wider than the column (a browser string has some) is broken where it stops
 * fitting. The text is wrapped in the order it was typed, so a right-to-left title still reads
 * from its first line down; each line stays in that order (the font puts it in visual order as it
 * draws it).
 */
export function wrapped(font, text, size, width) {
  const fits = value => font.widthOfTextAtSize(value, size) <= width;
  const lines = [];
  let line = '';
  for (const word of String(text || '').split(' ')) {
    if (!word) continue;
    const joined = line ? `${line} ${word}` : word;
    if (fits(joined)) {
      line = joined;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    if (fits(word)) {
      line = word;
      continue;
    }
    for (const ch of Array.from(word)) {
      if (line && !fits(line + ch)) {
        lines.push(line);
        line = ch;
      } else line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The name a signer confirmed for this document, or '' when they confirmed none.
 *
 * OpenSign keeps one contact for an email address across the whole platform, named by whoever
 * first sent that address anything. The name that belongs on a document is the one its signer
 * gave when signing it, which the gateway writes on the document itself: ScenticSignerNames, a
 * list of { email, name } (a list, not a map: an address has dots, which a stored key cannot).
 */
export function confirmedName(names, email) {
  if (!Array.isArray(names)) return '';
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return '';
  const entry = names.find(n => n && typeof n === 'object' && String(n.email || '').trim().toLowerCase() === wanted);
  return entry && typeof entry.name === 'string' ? entry.name.trim() : '';
}

/**
 * The name to print for a signer: the one they confirmed, made drawable;
 * the contact's stored name only when they confirmed none, as it was printed before.
 */
export function scenticSignerName(docDetails, email, fallback, font) {
  const confirmed = confirmedName(docDetails?.ScenticSignerNames, email);
  return confirmed ? printable(font, confirmed) : fallback;
}

/** The text, cut with "..." so it is no wider than `width` at `size`. */
export function fitted(font, text, size, width) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (font.widthOfTextAtSize(`${chars.slice(0, mid).join('')}...`, size) <= width) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? `${chars.slice(0, low).join('').trimEnd()}...` : '';
}

/**
 * The firm a document was sent for, for the certificate's "Organization" line: the name the
 * gateway wrote on the document when it was created, drawable and no wider than
 * `width`. `fallback` (what OpenSign printed: the company of the account that owns the document,
 * which is the platform's one account for every firm) only when the document names no firm.
 */
export function scenticOrganization(docDetails, fallback, font, width) {
  for (const value of [docDetails?.ScenticFirmName, docDetails?.FirmName]) {
    if (typeof value !== 'string') continue;
    const name = printable(font, value);
    if (name) return width > 0 ? fitted(font, name, 13, width) : name;
  }
  return fallback;
}

/**
 * One line of the certificate's own (the originator's name, the originator's address): drawable,
 * and cut with "..." if it would run past `width` at `size`.
 */
export function scenticLine(font, value, size, width) {
  return fitted(font, printable(font, value), size, width);
}

/** The events worth printing, cleaned and in the order they happened. */
export function eventRows(font, events, names) {
  if (!Array.isArray(events)) return [];
  const rows = [];
  for (const [index, e] of events.slice(0, MAX_EVENTS).entries()) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const time = new Date(typeof e.at === 'string' || typeof e.at === 'number' ? e.at : NaN).getTime();
    const row = {
      index,
      time: Number.isNaN(time) ? Infinity : time,
      when: utcStamp(e.at) || printable(font, e.at),
      event: printable(font, e.event),
      // Who: as the record names them; where it gives only an address, the name they confirmed.
      actor: printable(font, e.actor) || printable(font, confirmedName(names, e.email)),
      email: printable(font, e.email),
      ip: printable(font, e.ipAddress),
      // Whole, in the order it was sent; cut into lines when it is drawn.
      browser: clean(font, e.userAgent, MAX_BROWSER),
      detail: printable(font, e.detail),
    };
    if (row.when || row.event || row.actor || row.email) rows.push(row);
  }
  // By time; at the same instant, in the order given. Undated entries last.
  return rows.sort((a, b) => (a.time === b.time ? a.index - b.index : a.time - b.time));
}

/**
 * Draw the section. `page` and `y` are where the signers ended: the section starts there if a
 * heading and at least one row fit, otherwise on a new page. Returns the pages it added.
 */
export function drawScenticEventHistory({ pdfDoc, font, events, names, page, y, startX = 15, startY = 15, borderColor = rgb(0.12, 0.12, 0.12), titleColor = rgb(0, 0.2, 0.4) }) {
  const rows = eventRows(font, events, names);
  if (rows.length === 0) return 0;

  const { width, height } = page.getSize();
  const left = 30;
  const right = width - 30;
  const bottom = startY + 20;
  const keyColor = rgb(0.12, 0.12, 0.12);
  const valueColor = rgb(0.3, 0.3, 0.3);
  const size = 8;
  const line = 10;
  // The browser string is printed whole, over as many lines as its column needs.
  const browserSize = 7;
  const browserLine = 8;
  // Time, event, who, address, browser: fractions of the width between the margins.
  const gap = 6;
  // The address column holds a full IPv6 address, uncut.
  const shares = [0.19, 0.19, 0.2, 0.22, 0.2];
  const columns = [];
  let x = left;
  for (const share of shares) {
    const w = (right - left) * share;
    columns.push({ x, w: w - gap });
    x += w;
  }

  let current = page;
  let cursor = y;
  let added = 0;

  const newPage = () => {
    current = pdfDoc.addPage([width, height]);
    current.drawRectangle({ x: startX, y: startY, width: width - 2 * startX, height: height - 2 * startY, borderColor, borderWidth: 1 });
    added++;
    cursor = height - 45;
  };
  const text = (value, column, atY, color, atSize = size) => {
    if (value) current.drawText(value, { x: columns[column].x, y: atY, size: atSize, font, color });
  };
  const heading = continued => {
    current.drawText(continued ? 'Event history (continued)' : 'Event history', { x: left, y: cursor, size: 13, font, color: titleColor });
    cursor -= 16;
    for (const [i, label] of ['Time (UTC)', 'Event', 'Who', 'IP address', 'Browser'].entries()) text(label, i, cursor, keyColor);
    cursor -= 4;
    current.drawLine({ start: { x: left, y: cursor }, end: { x: right, y: cursor }, color: borderColor, thickness: 0.5 });
    cursor -= line + 1;
  };

  // The heading, the column names and one row, or it starts on a page of its own.
  if (cursor - (16 + 4 + line + 1 + 2 * line) < bottom) newPage();
  heading(false);

  for (const row of rows) {
    const second = Boolean(row.email || row.detail);
    const browser = wrapped(font, row.browser, browserSize, columns[4].w);
    // As tall as its tallest column: the one or two lines on the left, or the browser's lines.
    const tall = Math.max((second ? 2 : 1) * line, browser.length * browserLine + (line - browserLine));
    const needed = tall + 2;
    if (cursor - needed < bottom) {
      newPage();
      heading(true);
    }
    text(fitted(font, row.when, size, columns[0].w), 0, cursor, valueColor);
    text(fitted(font, row.event, size, columns[1].w), 1, cursor, keyColor);
    text(fitted(font, row.actor, size, columns[2].w), 2, cursor, valueColor);
    // An address is evidence: made smaller to fit whole before it is ever cut.
    let ipSize = size;
    while (ipSize > 5.5 && font.widthOfTextAtSize(row.ip, ipSize) > columns[3].w) ipSize -= 0.5;
    text(fitted(font, row.ip, ipSize, columns[3].w), 3, cursor, valueColor, ipSize);
    for (const [i, part] of browser.entries()) text(part, 4, cursor - i * browserLine, valueColor, browserSize);
    if (second) {
      text(fitted(font, row.detail, size - 1, columns[1].w), 1, cursor - line, valueColor, size - 1);
      text(fitted(font, row.email, size - 1, columns[2].w), 2, cursor - line, valueColor, size - 1);
    }
    cursor -= needed;
  }
  return added;
}

/**
 * The documents sent together in one request, as the gateway stored them, ready to print: each
 * "<n> of <N> — <title>", the one this certificate is for marked "(this document)", with its
 * SHA-256 where one was given. In the order given; what is not an entry is passed over.
 */
export function relatedDocumentRows(font, documents) {
  if (!Array.isArray(documents)) return [];
  const dash = glyphs(font).has(0x2014) ? '\u2014' : '-';
  const whole = value => (Number.isInteger(value) && value > 0 && value < 100000 ? value : 0);
  const rows = [];
  for (const d of documents.slice(0, MAX_DOCUMENTS)) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const title = clean(font, d.title);
    const position = whole(d.position);
    const total = whole(d.total);
    if (!title && !position) continue;
    const place = position && total ? `${position} of ${total}` : position ? `${position}` : '';
    const sha = typeof d.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(d.sha256.trim()) ? d.sha256.trim().toLowerCase() : '';
    rows.push({
      text: [place, title].filter(Boolean).join(` ${dash} `) + (d.current === true ? ' (this document)' : ''),
      sha,
    });
  }
  return rows;
}

/**
 * Draw "Documents in this request" where the summary ended (`page`, `y`), over as many pages as it
 * takes. Returns null, having drawn nothing, when the document has no such list; otherwise
 * { page, y, added }: the page and height at which the "Document originator" block, whole, goes on.
 */
export function drawScenticRelatedDocuments({ pdfDoc, font, documents, page, y, startX = 15, startY = 15, borderColor = rgb(0.12, 0.12, 0.12), titleColor = rgb(0, 0.2, 0.4) }) {
  const rows = relatedDocumentRows(font, documents);
  if (rows.length === 0) return null;

  const { width, height } = page.getSize();
  const left = 30;
  const indent = 60;
  const right = width - 30;
  const bottom = startY + 20;
  const keyColor = rgb(0.12, 0.12, 0.12);
  const valueColor = rgb(0.3, 0.3, 0.3);
  const size = 12;
  const line = 15;
  const shaSize = 9;
  const shaLine = 12;
  // Everything is measured before anything is drawn.
  const blocks = rows.map(row => ({ lines: wrapped(font, row.text, size, right - indent), sha: row.sha }));

  let current = page;
  let cursor = y;
  let added = 0;
  const newPage = () => {
    current = pdfDoc.addPage([width, height]);
    current.drawRectangle({ x: startX, y: startY, width: width - 2 * startX, height: height - 2 * startY, borderColor, borderWidth: 1 });
    added++;
    cursor = height - 45;
  };
  const heading = continued => {
    current.drawText(continued ? 'Documents in this request (continued)' : 'Documents in this request', { x: left, y: cursor, size: 17, font, color: titleColor });
    cursor -= 20;
  };

  heading(false);
  for (const block of blocks) {
    // From this entry's first line to its last, and the gap before the next.
    const needed = block.lines.length * line + (block.sha ? shaLine : 0) + 3;
    if (cursor - needed < bottom) {
      newPage();
      heading(true);
    }
    for (const part of block.lines) {
      current.drawText(part, { x: indent, y: cursor, size, font, color: keyColor });
      cursor -= line;
    }
    if (block.sha) {
      current.drawText(`SHA-256 : ${block.sha}`, { x: indent, y: cursor + line - shaLine, size: shaSize, font, color: valueColor });
      cursor -= shaLine;
    }
    cursor -= 3;
  }
  // The originator block is a heading and three lines, 63 points down to its rule: kept together.
  cursor -= 5;
  if (cursor - 63 < bottom) newPage();
  return { page: current, y: cursor, added };
}
