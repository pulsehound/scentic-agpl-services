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

/** One megabyte: a drawn or typed signature is a few kilobytes; a photograph of one is not this. */
export const MAX_SIGNATURE_PNG_BYTES = 1024 * 1024;
export const MAX_AUDIT_EVENTS = 500;
export const MAX_AUDIT_STRING = 300;
export const MAX_DECLINE_REASON = 1000;

/** The decoded PDF a submission may carry when nothing else is configured: 45 MiB. */
export const DEFAULT_MAX_PDF_BYTES = 45 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
 * The signature image: base64 of a PNG under a megabyte. A `data:image/png;base64,` prefix is
 * accepted and dropped; what is returned is the bare base64 OpenSign stores and later draws on the
 * certificate.
 */
export function checkSignaturePng(value: unknown): Checked<string> {
  const raw = typeof value === 'string' ? value.replace(/^data:image\/png;base64,/, '') : value;
  const decoded = decodeBase64(raw, 'signaturePngBase64', MAX_SIGNATURE_PNG_BYTES);
  if (!decoded.ok) return decoded;
  if (!decoded.value.subarray(0, 8).equals(PNG_MAGIC)) return bad('signaturePngBase64', 'not a PNG');
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
      const text = plainText(e[key] as string, MAX_AUDIT_STRING);
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
