// SPDX-License-Identifier: AGPL-3.0-or-later
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
// It must never be the reason a certificate is not made: whatever is in the record, it is reduced
// to text the certificate's font can draw, and anything that is not an event is passed over.
import { rgb } from 'pdf-lib';

const MAX_EVENTS = 500;
const MAX_TEXT = 300;

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
 * Right-to-left runs put in the order they are read, for a renderer that only lays glyphs out left
 * to right (pdf-lib has no bidirectional layout). Each run of Hebrew or Arabic letters, with the
 * spaces and punctuation between them, is reversed in place; Latin text and digits stay as they
 * are. This is not the Unicode bidirectional algorithm: a line mixing both directions keeps the
 * order of its runs, and Arabic letters are drawn unjoined.
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
 * Text the font can draw, on one line: control characters and line breaks become spaces, marks
 * that reorder text are dropped, a character the font has no glyph for becomes "?", and
 * right-to-left runs are put in reading order.
 */
export function printable(font, value) {
  if (value === null || value === undefined) return '';
  const have = glyphs(font);
  let out = '';
  for (const ch of Array.from(String(value)).slice(0, MAX_TEXT)) {
    const code = ch.codePointAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) out += ' ';
    else if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) continue;
    else out += have.has(code) ? ch : '?';
  }
  return visualOrder(out.replace(/ +/g, ' ').trim());
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

/** The events worth printing, cleaned and in the order they happened. */
export function eventRows(font, events) {
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
      actor: printable(font, e.actor),
      email: printable(font, e.email),
      ip: printable(font, e.ipAddress),
      browser: printable(font, e.userAgent),
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
export function drawScenticEventHistory({ pdfDoc, font, events, page, y, startX = 15, startY = 15, borderColor = rgb(0.12, 0.12, 0.12), titleColor = rgb(0, 0.2, 0.4) }) {
  const rows = eventRows(font, events);
  if (rows.length === 0) return 0;

  const { width, height } = page.getSize();
  const left = 30;
  const right = width - 30;
  const bottom = startY + 20;
  const keyColor = rgb(0.12, 0.12, 0.12);
  const valueColor = rgb(0.3, 0.3, 0.3);
  const size = 8;
  const line = 10;
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
    const needed = second ? 2 * line + 2 : line + 2;
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
    text(fitted(font, row.browser, size, columns[4].w), 4, cursor, valueColor);
    if (second) {
      cursor -= line;
      text(fitted(font, row.detail, size - 1, columns[1].w), 1, cursor, valueColor, size - 1);
      text(fitted(font, row.email, size - 1, columns[2].w), 2, cursor, valueColor, size - 1);
    }
    cursor -= line + 2;
  }
  return added;
}
