/**
 * The signing ceremony Scentic hosts: what a submission must look like before it goes anywhere.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Scentic shows the document to the signer, collects what they fill in, and stamps it onto the PDF
 * on its own server. The gateway receives the finished PDF and submits it to OpenSign as that
 * signer. Everything here is the checking done on the way in — pure, so the rules can be tested
 * without an OpenSign to talk to — and the lock that keeps two submissions for one document from
 * interleaving inside one gateway process.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { inflateSync } from 'node:zlib';

/** One megabyte: a drawn or typed signature is a few kilobytes; a photograph of one is not this. */
export const MAX_SIGNATURE_PNG_BYTES = 1024 * 1024;
export const MAX_AUDIT_EVENTS = 500;
export const MAX_AUDIT_STRING = 300;
/** A browser's User-Agent is kept whole: real ones run past 300 characters, and it is evidence. */
export const MAX_USER_AGENT = 512;
export const MAX_RELATED_DOCUMENTS = 50;
export const MAX_DOCUMENT_TITLE = 300;
/** Where a document stands among those sent together: "3 of 12". Far above any real request. */
export const MAX_DOCUMENT_POSITION = 1000;
export const MAX_DECLINE_REASON = 1000;

/** The decoded PDF a submission may carry when nothing else is configured: 45 MiB. */
export const DEFAULT_MAX_PDF_BYTES = 45 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A signature is a few hundred pixels across. Twice a wide phone's width is already generous. */
export const MAX_SIGNATURE_WIDTH = 2400;
export const MAX_SIGNATURE_HEIGHT = 1200;
// Colour type → the bit depths the PNG specification allows it, and its samples per pixel.
const PNG_COLOUR: Record<number, { depths: number[]; samples: number }> = {
  0: { depths: [1, 2, 4, 8, 16], samples: 1 },
  2: { depths: [8, 16], samples: 3 },
  3: { depths: [1, 2, 4, 8], samples: 1 },
  4: { depths: [8, 16], samples: 2 },
  6: { depths: [8, 16], samples: 4 },
};

// CRC-32 as PNG uses it (ISO 3309). Written out rather than taken from node:zlib, whose crc32 is
// only in Node 20.15 and later: the check must not depend on which minor the image happens to run.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// The chunks a still picture is made of, and the ones that only describe it. Nothing else is let
// through: not animation (acTL, fcTL, fdAT — each frame declares a size of its own, which a
// decoder allocates), and not a chunk this list has never heard of.
const PNG_PICTURE_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const PNG_DESCRIPTION_CHUNKS = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'tIME', 'tEXt', 'zTXt', 'iTXt']);
// The ones that can hold compressed or free text: allowed, never inflated here, and kept small.
const PNG_TEXT_CHUNKS = new Set(['iCCP', 'tEXt', 'zTXt', 'iTXt']);
export const MAX_PNG_TEXT_BYTES = 64 * 1024;

/**
 * Why a PNG must not be handed to OpenSign, or null when it may.
 *
 * OpenSign draws the signature on the certificate with a decoder that inflates and allocates
 * whatever the file tells it to. A megabyte of PNG can declare — or simply contain — gigabytes of
 * pixels, in its header, in its image data, or in the frames of an animation. So before it goes
 * anywhere, the whole file is walked, chunk by chunk:
 *
 *  - every chunk lies inside the file and its checksum is right; the file ends at IEND, with
 *    nothing after it;
 *  - the first chunk is a well-formed IHDR (13 bytes, dimensions above zero, a bit depth and
 *    colour type the specification pairs, no interlacing), and the picture is no larger than
 *    2400 x 1200;
 *  - only the chunks of a still picture and the ones that describe it are present, the
 *    descriptive text and colour profile together under 64 KB;
 *  - the image data inflates to exactly the size the header implies, inflated here under that cap,
 *    so a file that lies about its size is caught by the cap and not by running out of memory.
 */
export function pngProblem(bytes: Buffer): 'not a PNG' | 'not a valid PNG' | 'image too large' | null {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return 'not a PNG';

  let width = 0;
  let height = 0;
  let rowBytes = 0;
  let textBytes = 0;
  let seen = 0;
  let ended = false;
  const data: Buffer[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    if (ended) return 'not a valid PNG'; // something after IEND
    if (offset + 12 > bytes.length) return 'not a valid PNG';
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return 'not a valid PNG';
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (bytes.readUInt32BE(offset + 8 + length) !== crc32(bytes.subarray(offset + 4, offset + 8 + length))) return 'not a valid PNG';

    if (seen === 0) {
      if (type !== 'IHDR' || length !== 13) return 'not a valid PNG';
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8]!;
      const colour = PNG_COLOUR[body[9]!];
      if (width === 0 || height === 0) return 'not a valid PNG';
      if (!colour || !colour.depths.includes(depth)) return 'not a valid PNG';
      // Compression and filter methods have one value each; interlaced pictures are not taken (a
      // drawn or typed signature never is one, and their size is not the simple product below).
      if (body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return 'not a valid PNG';
      if (width > MAX_SIGNATURE_WIDTH || height > MAX_SIGNATURE_HEIGHT) return 'image too large';
      // One filter byte, then the row's samples.
      rowBytes = Math.ceil((width * colour.samples * depth) / 8) + 1;
    } else if (type === 'IHDR') {
      return 'not a valid PNG';
    } else if (!PNG_PICTURE_CHUNKS.has(type) && !PNG_DESCRIPTION_CHUNKS.has(type)) {
      return 'not a valid PNG';
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'IEND') {
      if (length !== 0) return 'not a valid PNG';
      ended = true;
    } else if (PNG_TEXT_CHUNKS.has(type)) {
      textBytes += length;
      if (textBytes > MAX_PNG_TEXT_BYTES) return 'not a valid PNG';
    }
    seen++;
    offset += 12 + length;
  }
  if (!ended || data.length === 0) return 'not a valid PNG';

  const expected = rowBytes * height;
  try {
    // maxOutputLength: inflating stops, and throws, one byte past what the header promised.
    if (inflateSync(Buffer.concat(data), { maxOutputLength: expected }).length !== expected) return 'not a valid PNG';
  } catch (err) {
    return (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'image too large' : 'not a valid PNG';
  }
  return null;
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type Checked<T> = { ok: true; value: T } | { ok: false; field: string; issue: string };

const bad = (field: string, issue: string): { ok: false; field: string; issue: string } => ({ ok: false, field, issue });

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The largest decoded PDF, from the same setting that limits a request body (GATEWAY_JSON_LIMIT,
 * "64mb" unless set). A body is JSON holding the PDF in base64 — four characters for every three
 * bytes — so the PDF's own ceiling is three quarters of the body's, less room for the rest of it.
 */
export function maxPdfBytesFromJsonLimit(limit: string | undefined): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(limit ?? '');
  if (!match) return DEFAULT_MAX_PDF_BYTES;
  const unit = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? 'b').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'];
  const bodyBytes = Number(match[1]) * unit;
  // The signature image (up to 1 MiB, base64) and the audit events share the body.
  const forPdf = Math.floor((bodyBytes - 3 * 1024 * 1024) * 0.75);
  return forPdf > 0 ? forPdf : DEFAULT_MAX_PDF_BYTES;
}

function decodeBase64(value: unknown, field: string, maxBytes: number): Checked<Buffer> {
  if (typeof value !== 'string' || value.length === 0) return bad(field, 'required');
  // Refused by length before decoding: nothing is allocated for a body that is too large anyway.
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) return bad(field, 'too large');
  if (value.length % 4 !== 0 || !BASE64.test(value)) return bad(field, 'not base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes) return bad(field, 'too large');
  return { ok: true, value: bytes };
}

/** A stamped PDF: base64 of bytes that begin "%PDF", no larger than the body limit allows. */
export function checkPdfBase64(value: unknown, maxBytes: number): Checked<Buffer> {
  const decoded = decodeBase64(value, 'pdfBase64', maxBytes);
  if (!decoded.ok) return decoded;
  if (decoded.value.subarray(0, 4).toString('latin1') !== '%PDF') return bad('pdfBase64', 'not a PDF');
  return decoded;
}

/**
 * The signature image: base64 of a well-formed PNG under a megabyte and no larger than 2400 × 1200
 * pixels (pngProblem). A `data:image/png;base64,` prefix is
 * accepted and dropped; what is returned is the bare base64 OpenSign stores and later draws on the
 * certificate.
 */
export function checkSignaturePng(value: unknown): Checked<string> {
  const raw = typeof value === 'string' ? value.replace(/^data:image\/png;base64,/, '') : value;
  const decoded = decodeBase64(raw, 'signaturePngBase64', MAX_SIGNATURE_PNG_BYTES);
  if (!decoded.ok) return decoded;
  const problem = pngProblem(decoded.value);
  if (problem) return bad('signaturePngBase64', problem);
  return { ok: true, value: raw as string };
}

/** An IPv4 or IPv6 address as written, or nothing. Never a list, a port or a host name. */
export function checkIpAddress(value: unknown, field = 'ipAddress'): Checked<string> {
  if (value === undefined || value === null || value === '') return { ok: true, value: '' };
  if (typeof value !== 'string') return bad(field, 'not an IP address');
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: '' };
  if (trimmed.length > 45 || isIP(trimmed) === 0) return bad(field, 'not an IP address');
  return { ok: true, value: trimmed };
}

export function checkEmail(value: unknown): Checked<string> {
  if (typeof value !== 'string') return bad('email', 'required');
  const email = value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 320) return bad('email', 'not an email address');
  return { ok: true, value: email };
}

export function checkSha256(value: unknown, field = 'baseSha256'): Checked<string> {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.trim())) return bad(field, 'not a SHA-256 in hex');
  return { ok: true, value: value.trim().toLowerCase() };
}

export const MAX_SIGNER_NAME = 200;

/**
 * The signer's own name, as they confirmed it: plain text on one line, 1 to 200 characters.
 * `required` where Scentic hosts the ceremony; elsewhere it may be left out (null).
 */
export function checkSignerName(value: unknown, required: boolean): Checked<string | null> {
  if (value === undefined || value === null) return required ? bad('signerName', 'required') : { ok: true, value: null };
  if (typeof value !== 'string') return bad('signerName', 'not a string');
  const name = plainText(value, MAX_SIGNER_NAME + 1);
  if (name === '') return bad('signerName', 'required');
  if (name.length > MAX_SIGNER_NAME) return bad('signerName', `at most ${MAX_SIGNER_NAME} characters`);
  return { ok: true, value: name };
}

/**
 * The document's confirmed names with one signer's set: theirs replaced, everybody else's kept.
 * Anything stored that is not a name entry is dropped.
 */
export function withSignerName(existing: unknown, email: string, name: string): Array<{ email: string; name: string }> {
  const kept = (Array.isArray(existing) ? existing : [])
    .filter((e): e is { email: string; name: string } => !!e && typeof e === 'object' && typeof (e as { email?: unknown }).email === 'string' && typeof (e as { name?: unknown }).name === 'string')
    .map((e) => ({ email: e.email.trim().toLowerCase(), name: e.name }))
    .filter((e) => e.email !== email);
  return [...kept, { email, name }];
}

export const MAX_FIRM_NAME = 200;
export const MAX_SENDER_EMAIL = 254;

/**
 * The address of the person who sent the request, for the certificate's originator block: one
 * address in the plain form mail systems accept (letters, digits and the usual punctuation before
 * the @, a dotted host name after it), at most 254 characters, lowercased. Nothing given is ''.
 * It is printed, never written to: no name part, no brackets, no list.
 */
export function checkSenderEmail(value: unknown): Checked<string> {
  if (value === undefined || value === null || value === '') return { ok: true, value: '' };
  if (typeof value !== 'string') return bad('senderEmail', 'not an email address');
  const email = value.trim().toLowerCase();
  if (email === '') return { ok: true, value: '' };
  if (email.length > MAX_SENDER_EMAIL || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email)) {
    return bad('senderEmail', 'not an email address');
  }
  return { ok: true, value: email };
}

/**
 * The sending firm's name as it should stand on the certificate, when create names one: plain text
 * on one line, at most 200 characters. Nothing given (absent, null, or nothing left once cleaned)
 * is null, and the name the firm was set up with is used.
 */
export function checkFirmName(value: unknown): Checked<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return bad('firmName', 'not a string');
  const name = plainText(value, MAX_FIRM_NAME + 1);
  if (Array.from(name).length > MAX_FIRM_NAME) return bad('firmName', `at most ${MAX_FIRM_NAME} characters`);
  return { ok: true, value: name || null };
}

/** Why a signer will not sign, in their words: required, trimmed, at most a thousand characters. */
export function checkDeclineReason(value: unknown): Checked<string> {
  if (typeof value !== 'string') return bad('reason', 'required');
  const reason = plainText(value, MAX_DECLINE_REASON + 1, true);
  if (reason === '') return bad('reason', 'required');
  if (reason.length > MAX_DECLINE_REASON) return bad('reason', `at most ${MAX_DECLINE_REASON} characters`);
  return { ok: true, value: reason };
}

/**
 * Plain text: no markup, no control characters, one line unless told otherwise, and no longer than
 * `max`. These strings are printed on a certificate and may be shown in a page; neither should have
 * to wonder what is in them.
 */
export function plainText(value: string, max: number, keepNewlines = false): string {
  let out = '';
  for (const ch of value.replace(/<[^>]*>/g, ' ')) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '<' || ch === '>') { out += ' '; continue; }
    if (code === 0x0a && keepNewlines) { out += ch; continue; }
    // Control characters, and the two Unicode line separators.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) { out += ' '; continue; }
    // Characters that reorder or hide the text around them: zero-width, direction marks and
    // overrides, isolates, the byte-order mark.
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) continue;
    out += ch;
  }
  const stripped = out.replace(/[ \t]+/g, ' ').trim();
  return Array.from(stripped).slice(0, max).join('').trim();
}

/** One line of Scentic's own record of a ceremony, as it is stored on the OpenSign document. */
export interface CeremonyAuditEvent {
  /** When, ISO 8601 in UTC. */
  at: string;
  /** What happened, in a few words: "Link opened", "Code verified", "Signed". */
  event: string;
  /** Who did it, as a person reads it: a name, or "Scentic". */
  actor: string;
  email?: string;
  ipAddress?: string;
  userAgent?: string;
  detail?: string;
}

/**
 * The events a submission carries: at most five hundred, each a time that parses, a non-empty event
 * and an actor, with every string reduced to plain text and capped. One bad entry refuses the whole
 * submission rather than being dropped — this is evidence, and a record with a silent hole in it is
 * worse than a refused request the caller can correct.
 */
export function checkAuditEvents(value: unknown): Checked<CeremonyAuditEvent[] | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return bad('auditEvents', 'not an array');
  if (value.length > MAX_AUDIT_EVENTS) return bad('auditEvents', `at most ${MAX_AUDIT_EVENTS} events`);

  const events: CeremonyAuditEvent[] = [];
  for (const [index, entry] of value.entries()) {
    const field = `auditEvents[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return bad(field, 'not an object');
    const e = entry as Record<string, unknown>;

    if (typeof e.at !== 'string') return bad(`${field}.at`, 'required');
    const at = new Date(e.at);
    if (Number.isNaN(at.getTime())) return bad(`${field}.at`, 'not a date');

    if (typeof e.event !== 'string') return bad(`${field}.event`, 'required');
    const event = plainText(e.event, MAX_AUDIT_STRING);
    if (!event) return bad(`${field}.event`, 'required');

    if (typeof e.actor !== 'string') return bad(`${field}.actor`, 'required');
    const actor = plainText(e.actor, MAX_AUDIT_STRING);

    const optional: Partial<CeremonyAuditEvent> = {};
    for (const key of ['email', 'userAgent', 'detail'] as const) {
      if (e[key] === undefined || e[key] === null) continue;
      if (typeof e[key] !== 'string') return bad(`${field}.${key}`, 'not a string');
      const text = plainText(e[key] as string, key === 'userAgent' ? MAX_USER_AGENT : MAX_AUDIT_STRING);
      if (text) optional[key] = key === 'email' ? text.toLowerCase() : text;
    }
    const ip = checkIpAddress(e.ipAddress, `${field}.ipAddress`);
    if (!ip.ok) return ip;
    if (ip.value) optional.ipAddress = ip.value;

    events.push({ at: at.toISOString(), event, actor, ...optional });
  }
  // In the order they happened; entries at the same instant keep the order they were sent in.
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at.localeCompare(b.event.at) || a.index - b.index)
    .map((x) => x.event);
  return { ok: true, value: ordered };
}

/** One of the documents sent to be signed together in one request, as the certificate lists it. */
export interface RelatedDocument {
  position: number;
  total: number;
  title: string;
  sha256?: string;
  /** The document the list is stored on: printed "(this document)". */
  current?: true;
}

const wholeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DOCUMENT_POSITION;

/** Which of the request's documents this one is (`position` on ceremony/sign), or nothing. */
export function checkDocumentPosition(value: unknown): Checked<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!wholeNumber(value)) return bad('position', `a whole number from 1 to ${MAX_DOCUMENT_POSITION}`);
  return { ok: true, value };
}

/**
 * The documents sent together in one request: at most fifty, each with where it stands
 * (`position` of `total`, whole numbers, position no greater than total), a title reduced to plain
 * text of 1 to 300 characters, and optionally the SHA-256 of its PDF. Kept in the order given. The
 * entry whose position is `current` is marked as the document the list is stored on. As with the
 * events, one bad entry refuses the whole submission.
 */
export function checkRelatedDocuments(value: unknown, current: number | null = null): Checked<RelatedDocument[] | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) return bad('relatedDocuments', 'not an array');
  if (value.length > MAX_RELATED_DOCUMENTS) return bad('relatedDocuments', `at most ${MAX_RELATED_DOCUMENTS} documents`);

  const documents: RelatedDocument[] = [];
  for (const [index, entry] of value.entries()) {
    const field = `relatedDocuments[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return bad(field, 'not an object');
    const e = entry as Record<string, unknown>;
    for (const key of ['position', 'total'] as const) {
      if (!wholeNumber(e[key])) return bad(`${field}.${key}`, `a whole number from 1 to ${MAX_DOCUMENT_POSITION}`);
    }
    const position = e.position as number;
    const total = e.total as number;
    if (position > total) return bad(`${field}.position`, 'greater than total');

    if (typeof e.title !== 'string') return bad(`${field}.title`, 'required');
    const title = plainText(e.title, MAX_DOCUMENT_TITLE + 1);
    if (title === '') return bad(`${field}.title`, 'required');
    if (Array.from(title).length > MAX_DOCUMENT_TITLE) return bad(`${field}.title`, `at most ${MAX_DOCUMENT_TITLE} characters`);

    let sha256: string | undefined;
    if (e.sha256 !== undefined && e.sha256 !== null) {
      const sha = checkSha256(e.sha256, `${field}.sha256`);
      if (!sha.ok) return sha;
      sha256 = sha.value;
    }
    documents.push({ position, total, title, ...(sha256 ? { sha256 } : {}), ...(current !== null && position === current ? { current: true as const } : {}) });
  }
  return { ok: true, value: documents };
}

/**
 * The document's list with a submission's entries merged in, by position: an entry sent replaces
 * the stored one at its position, an entry not sent stays, and nothing is ever removed — each
 * signer's submission carries the list as Scentic knew it then, and a later, shorter one must not
 * take a document off a certificate. In order of position. `current` (this submission's
 * `position`), when given, moves the "(this document)" mark to that entry; otherwise the mark
 * stays where it was. Anything stored that is not an entry is dropped. Null when the merged list
 * would run past fifty.
 */
export function mergeRelatedDocuments(existing: unknown, incoming: RelatedDocument[], current: number | null): RelatedDocument[] | null {
  const byPosition = new Map<number, RelatedDocument>();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const d = e as Record<string, unknown>;
    if (!wholeNumber(d.position) || !wholeNumber(d.total) || typeof d.title !== 'string' || d.title === '') continue;
    byPosition.set(d.position, {
      position: d.position,
      total: d.total,
      title: d.title,
      ...(typeof d.sha256 === 'string' && /^[0-9a-f]{64}$/.test(d.sha256) ? { sha256: d.sha256 } : {}),
      ...(d.current === true ? { current: true as const } : {}),
    });
  }
  for (const d of incoming) {
    const kept = byPosition.get(d.position);
    // The mark is decided below; an entry sent without a hash keeps the one already stored.
    const { current: _mark, ...entry } = d;
    byPosition.set(d.position, {
      ...entry,
      ...(!entry.sha256 && kept?.sha256 ? { sha256: kept.sha256 } : {}),
      ...(kept?.current ? { current: true as const } : {}),
    });
  }
  if (byPosition.size > MAX_RELATED_DOCUMENTS) return null;
  const merged = [...byPosition.values()].sort((a, b) => a.position - b.position);
  if (current === null || !byPosition.has(current)) return merged;
  return merged.map(({ current: _mark, ...d }) => (d.position === current ? { ...d, current: true as const } : d));
}

/**
 * One at a time, per key, inside this process.
 *
 * A submission reads the document's current PDF, compares it with the one the caller stamped, and
 * only then hands the new one to OpenSign, which simply overwrites. Two submissions for one
 * document must not both pass the comparison before either has written.
 *
 * This holds for one gateway instance only. Across instances the same guarantee is Scentic's: it
 * takes a claim on the signature request in its own database before it calls here, so two calls
 * for one workflow never run at once wherever they land. The compare against `baseSha256` remains
 * the last line either way: a submission built on a PDF that is no longer current is refused.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = before.then(() => mine);
    this.tails.set(key, tail);
    await before;
    try {
      return await task();
    } finally {
      release();
      // Nothing queued behind this one: forget the key, so the map holds only what is waiting.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
