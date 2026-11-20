/**
 * The signing ceremony Scentic hosts: .../ceremony/file, viewed, sign, decline; `ceremony` on create;
 * who declined, in a status.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Run through the real routes, service and OpenSignClient against a stand-in Parse server
 * (fake-parse.ts), so what is asserted is what would be sent to OpenSign and as whom.
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { WorkflowLockBusy } from '../mappings/mapping-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteMappingStore } from '../storage/sqlite-store.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeApp, signedRequest, type MockOpenSignClient, type TestApp } from './helpers.js';
import { makeFakeParse, type FakeParse } from './fake-parse.js';
import { OpenSignClient, forwardedFor } from '../opensign/opensign-client.js';
import { SIGNATURE_CAPABILITIES } from '../routes/signature.js';
import { SIGN_IN_DOUBT_MS, SIGN_IN_DOUBT_SHORT_MS } from '../opensign/opensign-service.js';
import { InMemoryMappingStore, type MappingStore } from '../mappings/mapping-store.js';
import {
  KeyedMutex,
  MAX_AUDIT_EVENTS,
  MAX_RELATED_DOCUMENTS,
  MAX_USER_AGENT,
  checkAuditEvents,
  checkDocumentPosition,
  checkRelatedDocuments,
  checkDeclineReason,
  checkIpAddress,
  checkPdfBase64,
  checkSignaturePng,
  pngProblem,
  crc32,
  MAX_PNG_TEXT_BYTES,
  maxPdfBytesFromJsonLimit,
  plainText,
} from '../opensign/ceremony.js';
import { declinedByEmail, signerRows } from '../opensign/signer-changes.js';

const FIRM1 = 'firm-11111111';
const FIRM2 = 'firm-22222222';
const WF = 'wf-ceremony';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pdf = (label: string) => Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, 'latin1');
const ORIGINAL = pdf('original');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
/** A real PNG of that size (blank), or one made wrong in a named way. */
function makePng(width: number, height: number, o: { depth?: number; colour?: number; interlace?: number; ihdrLength?: number; badCrc?: boolean; pixels?: Buffer; noData?: boolean; noEnd?: boolean; extra?: Buffer[]; after?: Buffer; endData?: Buffer } = {}) {
  const depth = o.depth ?? 8;
  const colour = o.colour ?? 6;
  const ihdr = Buffer.alloc(o.ihdrLength ?? 13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colour;
  ihdr[12] = o.interlace ?? 0;
  const samples = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour] ?? 4;
  const pixels = o.pixels ?? Buffer.alloc((Math.ceil((width * samples * depth) / 8) + 1) * height);
  const header = chunk('IHDR', ihdr);
  if (o.badCrc) header[header.length - 1] ^= 0xff;
  return Buffer.concat([PNG_MAGIC, header, ...(o.extra ?? []), ...(o.noData ? [] : [chunk('IDAT', deflateSync(pixels))]), ...(o.noEnd ? [] : [chunk('IEND', o.endData ?? Buffer.alloc(0))]), ...(o.after ? [o.after] : [])]);
}
const PNG = makePng(300, 100);
const PNG_B64 = PNG.toString('base64');

interface Harness extends TestApp {
  parse: FakeParse;
  logs: string[];
}

function harness(timeouts?: { signMs?: number; otherMs?: number; readMs?: number; fileMs?: number }, store?: MappingStore): Harness {
  const parse = makeFakeParse();
  vi.stubGlobal('fetch', parse.fetch);
  const logs: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const client = new OpenSignClient({
    baseUrl: 'http://localhost:8080/app',
    appId: 'opensign',
    masterKey: 'test-master-key',
    adminEmail: 'admin@opensign.test',
    adminPassword: 'test-password',
    timeouts,
  });
  const t = makeApp({ opensignClient: client as unknown as MockOpenSignClient, ...(store ? { store: store as unknown as InMemoryMappingStore } : {}) });
  return { ...t, parse, logs };
}

async function createWorkflow(
  h: Harness,
  extra: Record<string, unknown> = { ceremony: 'scentic' },
  firmId = FIRM1,
  workflowId = WF,
) {
  await h.opensignService!.initFirm({ scenticFirmId: firmId, firmName: 'Acme Law' }, 'corr');
  const res = await signedRequest(h.app, {
    method: 'POST',
    path: `/api/v1/firms/${firmId}/signature/workflows`,
    bodyObj: {
      scenticSignatureWorkflowId: workflowId,
      scenticMatterId: 'matter-1',
      scenticDocumentId: 'doc-1',
      documentName: 'contract.pdf',
      documentBase64: ORIGINAL.toString('base64'),
      signers: [
        { scenticSignerId: 's1', email: ALICE, name: 'Alice', role: 'signer', order: 1 },
        { scenticSignerId: 's2', email: BOB, name: 'Bob', role: 'signer', order: 2 },
      ],
      sendInOrder: true,
      ...extra,
    },
    firmId,
    idempotencyKey: `create-${workflowId}`,
  });
  expect(res.status).toBe(200);
  return res;
}

const ceremony = (h: Harness, action: string, bodyObj: unknown, firmId = FIRM1, workflowId = WF, signedAs = firmId) =>
  signedRequest(h.app, {
    method: 'POST',
    path: `/api/v1/firms/${firmId}/signature/workflows/${workflowId}/ceremony/${action}`,
    bodyObj,
    firmId: signedAs,
    idempotencyKey: `${action}-${Math.random()}`,
  });

const ceremonyFile = (h: Harness, firmId = FIRM1, workflowId = WF, signedAs = firmId) =>
  signedRequest(h.app, {
    method: 'GET',
    path: `/api/v1/firms/${firmId}/signature/workflows/${workflowId}/ceremony/file`,
    firmId: signedAs,
  }).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

const signBody = (email: string, stamped: Buffer, base: Buffer, extra: Record<string, unknown> = {}) => ({
  email,
  signerName: 'Signer Confirmed',
  pdfBase64: stamped.toString('base64'),
  signaturePngBase64: PNG_B64,
  ipAddress: '203.0.113.7',
  baseSha256: sha(base),
  ...extra,
});

const callsTo = (h: Harness, fn: string) => h.parse.calls.filter((c) => c.path === `/functions/${fn}`);

describe('ceremony endpoints', () => {
  let h: Harness;

  beforeEach(() => { h = harness(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  // ── file ──────────────────────────────────────────────────────────────

  it('file: streams the current PDF with its hash, the original before anyone signs', async () => {
    await createWorkflow(h);
    const res = await ceremonyFile(h);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-sha256']).toBe(sha(ORIGINAL));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(res.body as Buffer, ORIGINAL)).toBe(0);
  });

  it('file: after a signature, streams the signed PDF (SignedUrl), not the original', async () => {
    await createWorkflow(h);
    const stamped = pdf('alice signed');
    expect((await ceremony(h, 'sign', signBody(ALICE, stamped, ORIGINAL))).status).toBe(200);
    const res = await ceremonyFile(h);
    expect(res.status).toBe(200);
    expect(res.headers['x-content-sha256']).toBe(sha(stamped));
    expect(Buffer.compare(res.body as Buffer, stamped)).toBe(0);
  });

  it('file: a withdrawn request is refused with INVALID_STATE', async () => {
    await createWorkflow(h);
    const cancelled = await signedRequest(h.app, {
      method: 'POST', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/cancel`, bodyObj: { reason: 'sent by mistake' }, firmId: FIRM1, idempotencyKey: 'c1',
    });
    expect(cancelled.status).toBe(200);
    const res = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/ceremony/file`, firmId: FIRM1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect(res.body.error.retryable).toBe(false);
  });

  it('file: archived in OpenSign without the gateway knowing is still INVALID_STATE', async () => {
    await createWorkflow(h);
    h.parse.doc().IsArchive = true;
    const res = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/ceremony/file`, firmId: FIRM1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  // ── firm scope, unknown workflow: all four ────────────────────────────

  it('firm mismatch: a request signed for another firm than the path is 403 on every ceremony route', async () => {
    await createWorkflow(h);
    const file = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/ceremony/file`, firmId: FIRM2 });
    expect(file.status).toBe(403);
    expect(file.body.error.code).toBe('FIRM_SCOPE_VIOLATION');
    for (const [action, body] of [
      ['viewed', { email: ALICE, ipAddress: '' }],
      ['sign', signBody(ALICE, pdf('x'), ORIGINAL)],
      ['decline', { email: ALICE, reason: 'no', ipAddress: '' }],
    ] as const) {
      const res = await ceremony(h, action, body, FIRM1, WF, FIRM2);
      expect(res.status, action).toBe(403);
      expect(res.body.error.code, action).toBe('FIRM_SCOPE_VIOLATION');
    }
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
    expect(callsTo(h, 'declinedoc')).toHaveLength(0);
  });

  it("another firm's workflow is not found, on every ceremony route, and nothing reaches OpenSign", async () => {
    await createWorkflow(h);
    await h.opensignService!.initFirm({ scenticFirmId: FIRM2, firmName: 'Beta Law' }, 'corr');
    const before = h.parse.calls.length;
    const file = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM2}/signature/workflows/${WF}/ceremony/file`, firmId: FIRM2 });
    expect(file.status).toBe(404);
    expect(file.body.error.code).toBe('NOT_FOUND');
    for (const [action, body] of [
      ['viewed', { email: ALICE, ipAddress: '' }],
      ['sign', signBody(ALICE, pdf('x'), ORIGINAL)],
      ['decline', { email: ALICE, reason: 'no', ipAddress: '' }],
    ] as const) {
      const res = await ceremony(h, action, body, FIRM2);
      expect(res.status, action).toBe(404);
      expect(res.body.error.code, action).toBe('NOT_FOUND');
    }
    expect(h.parse.calls.length).toBe(before);
  });

  it('an unknown workflow is not found on every ceremony route', async () => {
    await createWorkflow(h);
    const file = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/nope/ceremony/file`, firmId: FIRM1 });
    expect(file.status).toBe(404);
    for (const [action, body] of [
      ['viewed', { email: ALICE, ipAddress: '' }],
      ['sign', signBody(ALICE, pdf('x'), ORIGINAL)],
      ['decline', { email: ALICE, reason: 'no', ipAddress: '' }],
    ] as const) {
      const res = await ceremony(h, action, body, FIRM1, 'nope');
      expect(res.status, action).toBe(404);
      expect(res.body.error.code, action).toBe('NOT_FOUND');
    }
  });

  // ── viewed ────────────────────────────────────────────────────────────

  it("viewed: records OpenSign's Viewed entry as that signer, from the signer's address, once", async () => {
    await createWorkflow(h);
    const first = await ceremony(h, 'viewed', { email: 'Alice@Example.com ', ipAddress: '198.51.100.4' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true, data: { viewed: true, recorded: true } });

    const [call] = callsTo(h, 'triggerevent');
    expect(call!.body).toEqual({ event: 'viewed', contactId: 'contact-1', body: { objectId: 'os-doc-1' } });
    expect(call!.headers['x-forwarded-for']).toBe('198.51.100.4');
    // The server's own call, naming the signer; no session of the signer's is made or used.
    expect(call!.headers['x-parse-master-key']).toBe('test-master-key');
    expect(call!.headers['sessiontoken']).toBeUndefined();
    expect(call!.headers['x-parse-session-token']).toBeUndefined();
    expect(h.parse.doc().AuditTrail).toEqual([expect.objectContaining({ Activity: 'Viewed', ipAddress: '198.51.100.4' })]);

    // Idempotent: asked again, nothing more is written.
    const second = await ceremony(h, 'viewed', { email: ALICE, ipAddress: '198.51.100.99' });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ viewed: true, recorded: false });
    expect(callsTo(h, 'triggerevent')).toHaveLength(1);
    expect(h.parse.doc().AuditTrail[0].ipAddress).toBe('198.51.100.4');
  });

  it('viewed: after signing it does not turn the Signed entry back into Viewed', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL))).status).toBe(200);
    const res = await ceremony(h, 'viewed', { email: ALICE, ipAddress: '198.51.100.4' });
    expect(res.status).toBe(200);
    expect(res.body.data.recorded).toBe(false);
    expect(callsTo(h, 'triggerevent')).toHaveLength(0);
    expect(h.parse.doc().AuditTrail[0].Activity).toBe('Signed');
  });

  it('viewed: not a signer, a bad address, a bad IP', async () => {
    await createWorkflow(h);
    const stranger = await ceremony(h, 'viewed', { email: 'mallory@example.com', ipAddress: '' });
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe('NOT_A_SIGNER');
    expect(stranger.body.error.retryable).toBe(false);
    expect((await ceremony(h, 'viewed', { ipAddress: '' })).body.error.code).toBe('INVALID_INPUT');
    const badIp = await ceremony(h, 'viewed', { email: ALICE, ipAddress: '203.0.113.7, 10.0.0.1' });
    expect(badIp.status).toBe(400);
    expect(badIp.body.error.details).toEqual([expect.objectContaining({ field: 'ipAddress' })]);
    expect(callsTo(h, 'triggerevent')).toHaveLength(0);
  });

  // ── sign ──────────────────────────────────────────────────────────────

  it("sign: submits the stamped PDF as that signer, from the signer's address; the next base is its hash", async () => {
    await createWorkflow(h);
    const stamped = pdf('alice signed');
    const res = await ceremony(h, 'sign', signBody(ALICE, stamped, ORIGINAL));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { signed: true, completed: false, sha256: sha(stamped) } });

    const [call] = callsTo(h, 'signPdf');
    expect(call!.body).toEqual({
      pdfFile: stamped.toString('base64'),
      docId: 'os-doc-1',
      userId: 'contact-1',
      signature: PNG_B64,
      isCustomCompletionMail: false,
    });
    expect(call!.headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(call!.headers['x-parse-master-key']).toBe('test-master-key');
    expect(call!.headers['x-parse-session-token']).toBeUndefined();
    // Nobody is signed in as the signer, ever.
    expect(h.parse.calls.some((c) => c.path === '/loginAs')).toBe(false);
    expect(Buffer.compare(h.parse.currentFile(), stamped)).toBe(0);
    expect(h.parse.doc().AuditTrail).toEqual([expect.objectContaining({ Activity: 'Signed', ipAddress: '203.0.113.7' })]);
  });

  it('sign: the last signature completes the document; sha256 is the hash OpenSign sealed', async () => {
    await createWorkflow(h);
    const one = pdf('alice');
    const two = pdf('alice+bob');
    expect((await ceremony(h, 'sign', signBody(ALICE, one, ORIGINAL))).body.data.completed).toBe(false);
    const res = await ceremony(h, 'sign', signBody(BOB, two, one));
    expect(res.status).toBe(200);
    expect(res.body.data.signed).toBe(true);
    expect(res.body.data.completed).toBe(true);
    expect(res.body.data.sha256).toBe(h.parse.doc().DocumentHash);
  });

  it('sign: without an address OpenSign is told "unknown", never left to record the gateway', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { ipAddress: '' }))).status).toBe(200);
    expect(callsTo(h, 'signPdf')[0]!.headers['x-forwarded-for']).toBe('unknown');
    expect(forwardedFor('  ')).toBe('unknown');
    expect(forwardedFor('2001:db8::1')).toBe('2001:db8::1');
  });

  it('sign: an IPv6 address is accepted and forwarded as written', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { ipAddress: '2001:db8::7' }))).status).toBe(200);
    expect(callsTo(h, 'signPdf')[0]!.headers['x-forwarded-for']).toBe('2001:db8::7');
  });

  it('sign: not a signer', async () => {
    await createWorkflow(h);
    const res = await ceremony(h, 'sign', signBody('mallory@example.com', pdf('m'), ORIGINAL));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_A_SIGNER');
    expect(res.body.error.retryable).toBe(false);
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
    expect(h.parse.calls.some((c) => c.path === '/loginAs')).toBe(false);
  });

  it('sign: already signed, even with the current hash', async () => {
    await createWorkflow(h);
    const one = pdf('alice');
    expect((await ceremony(h, 'sign', signBody(ALICE, one, ORIGINAL))).status).toBe(200);
    const again = await ceremony(h, 'sign', signBody(ALICE, pdf('alice again'), one));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SIGNED');
    expect(again.body.error.retryable).toBe(false);
    expect(callsTo(h, 'signPdf')).toHaveLength(1);
    expect(Buffer.compare(h.parse.currentFile(), one)).toBe(0);
  });

  it('sign: a stale base hash is a retryable conflict and writes nothing', async () => {
    await createWorkflow(h);
    const one = pdf('alice');
    expect((await ceremony(h, 'sign', signBody(ALICE, one, ORIGINAL))).status).toBe(200);
    // Bob stamped the original, which is no longer the current PDF.
    const stale = await ceremony(h, 'sign', signBody(BOB, pdf('bob on the original'), ORIGINAL, {
      auditEvents: [{ at: '2026-11-19T10:00:00Z', event: 'Signed', actor: 'Bob' }],
    }));
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_DOCUMENT');
    expect(stale.body.error.retryable).toBe(true);
    expect(callsTo(h, 'signPdf')).toHaveLength(1);
    expect(h.parse.doc().ScenticAudit).toBeUndefined();
    expect(Buffer.compare(h.parse.currentFile(), one)).toBe(0);
    // Fetch again, stamp again, retry: accepted.
    const file = await ceremonyFile(h);
    const retry = await ceremony(h, 'sign', { ...signBody(BOB, pdf('alice+bob'), one), baseSha256: file.headers['x-content-sha256'] });
    expect(retry.status).toBe(200);
    expect(retry.body.data.completed).toBe(true);
  });

  it('sign: two signers at once on one base — one is accepted, the other sees its result and is STALE_DOCUMENT', async () => {
    await createWorkflow(h);
    h.parse.signDelayMs = 40;
    const [a, b] = await Promise.all([
      ceremony(h, 'sign', signBody(ALICE, pdf('alice on original'), ORIGINAL)),
      ceremony(h, 'sign', signBody(BOB, pdf('bob on original'), ORIGINAL)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('STALE_DOCUMENT');
    expect(loser.body.error.retryable).toBe(true);
    // Serialised: never two submissions in flight, and only the winner reached OpenSign.
    expect(h.parse.maxConcurrentSigns()).toBe(1);
    expect(callsTo(h, 'signPdf')).toHaveLength(1);
    expect(h.parse.doc().AuditTrail.filter((e: { Activity: string }) => e.Activity === 'Signed')).toHaveLength(1);
    expect(h.parse.doc().IsCompleted).toBe(false);
  });

  it('sign: a body that is not a PDF', async () => {
    await createWorkflow(h);
    const res = await ceremony(h, 'sign', signBody(ALICE, Buffer.from('<html>not a pdf</html>'), ORIGINAL));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(res.body.error.details).toEqual([{ ok: false, field: 'pdfBase64', issue: 'not a PDF' }].map(({ field, issue }) => expect.objectContaining({ field, issue })));
    const notBase64 = await ceremony(h, 'sign', { ...signBody(ALICE, pdf('a'), ORIGINAL), pdfBase64: '%PDF-1.7 raw, not base64' });
    expect(notBase64.status).toBe(400);
    expect(notBase64.body.error.details[0]).toMatchObject({ field: 'pdfBase64', issue: 'not base64' });
    const missing = await ceremony(h, 'sign', { ...signBody(ALICE, pdf('a'), ORIGINAL), pdfBase64: undefined });
    expect(missing.status).toBe(400);
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
  });

  it('sign: a signature image that is not a PNG, or is over a megabyte', async () => {
    await createWorkflow(h);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]).toString('base64');
    const notPng = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signaturePngBase64: jpeg }));
    expect(notPng.status).toBe(400);
    expect(notPng.body.error.code).toBe('INVALID_INPUT');
    expect(notPng.body.error.details[0]).toMatchObject({ field: 'signaturePngBase64', issue: 'not a PNG' });

    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(1024 * 1024)]).toString('base64');
    const tooBig = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signaturePngBase64: big }));
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(tooBig.body.error.retryable).toBe(false);
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
  });

  it('sign: a data-URL prefix on the signature is accepted and dropped', async () => {
    await createWorkflow(h);
    const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signaturePngBase64: `data:image/png;base64,${PNG_B64}` }));
    expect(res.status).toBe(200);
    expect(callsTo(h, 'signPdf')[0]!.body!.signature).toBe(PNG_B64);
  });

  it('sign: an invalid IP, a bad base hash', async () => {
    await createWorkflow(h);
    for (const ipAddress of ['999.1.1.1', 'example.com', '203.0.113.7:443', '203.0.113.7\r\nX-Evil: 1', 42]) {
      const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { ipAddress }));
      expect(res.status, String(ipAddress)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.details[0].field).toBe('ipAddress');
    }
    const badHash = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { baseSha256: 'abc' }));
    expect(badHash.status).toBe(400);
    expect(badHash.body.error.details[0].field).toBe('baseSha256');
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
  });

  it('sign: audit events are written to the document as ScenticAudit before signPdf, cleaned and in time order', async () => {
    await createWorkflow(h);
    const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, {
      auditEvents: [
        { at: '2026-11-19T10:05:00+02:00', event: 'Signed', actor: 'Alice', email: 'ALICE@example.com', ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0', detail: 'x'.repeat(400) },
        { at: '2026-11-19T08:00:00Z', event: '<b>Link opened</b>\n', actor: 'Alice <script>alert(1)</script>' },
      ],
    }));
    expect(res.status).toBe(200);
    const audit = h.parse.doc().ScenticAudit;
    expect(audit).toEqual([
      { at: '2026-11-19T08:00:00.000Z', event: 'Link opened', actor: 'Alice alert(1)' },
      { at: '2026-11-19T08:05:00.000Z', event: 'Signed', actor: 'Alice', email: 'alice@example.com', ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0', detail: 'x'.repeat(300) },
    ]);
    const put = h.parse.calls.findIndex((c) => c.method === 'PUT' && c.body && 'ScenticAudit' in c.body);
    const signed = h.parse.calls.findIndex((c) => c.path === '/functions/signPdf');
    expect(put).toBeGreaterThan(-1);
    expect(put).toBeLessThan(signed);
    expect(h.parse.calls[put]!.headers['x-parse-master-key']).toBe('test-master-key');
  });

  it('sign: a browser string is kept whole up to 512 characters; every other string is still cut at 300', async () => {
    await createWorkflow(h);
    // Chrome on a Samsung phone, as it really arrives through an in-app browser: 180 characters.
    const android = 'Mozilla/5.0 (Linux; Android 15; SM-S918BB Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 Instagram 337.0.0';
    expect(android.length).toBe(180);
    const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, {
      auditEvents: [
        { at: '2026-11-19T08:00:00Z', event: 'Link opened', actor: 'Alice', userAgent: android },
        { at: '2026-11-19T08:01:00Z', event: 'e'.repeat(400), actor: 'a'.repeat(400), userAgent: 'u'.repeat(600), detail: 'd'.repeat(400) },
      ],
    }));
    expect(res.status).toBe(200);
    const audit = h.parse.doc().ScenticAudit;
    expect(audit[0].userAgent).toBe(android);
    expect(MAX_USER_AGENT).toBe(512);
    expect(audit[1].userAgent).toBe('u'.repeat(512));
    expect(audit[1].event).toBe('e'.repeat(300));
    expect(audit[1].actor).toBe('a'.repeat(300));
    expect(audit[1].detail).toBe('d'.repeat(300));
  });

  it('sign: the documents of the request are stored on the document, this one marked, replaced by each call and left alone by a call without them', async () => {
    await createWorkflow(h);
    const hebrew = 'הסכם שכר טרחה';
    const three = [
      { position: 1, total: 3, title: 'Engagement letter', sha256: 'AB'.repeat(32) },
      { position: 2, total: 3, title: `<b>${hebrew}</b>\n` },
      { position: 3, total: 3, title: 'Power of attorney', sha256: 'cd'.repeat(32), extra: 'dropped' },
    ];
    const first = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { relatedDocuments: three, position: 2 }));
    expect(first.status).toBe(200);
    expect(h.parse.doc().ScenticRelatedDocuments).toEqual([
      { position: 1, total: 3, title: 'Engagement letter', sha256: 'ab'.repeat(32) },
      { position: 2, total: 3, title: hebrew, current: true },
      { position: 3, total: 3, title: 'Power of attorney', sha256: 'cd'.repeat(32) },
    ]);
    // Written with the master key, before the signature: the last signature makes the certificate.
    const put = h.parse.calls.findIndex((c) => c.method === 'PUT' && c.body && 'ScenticRelatedDocuments' in c.body);
    expect(put).toBeGreaterThan(-1);
    expect(put).toBeLessThan(h.parse.calls.findIndex((c) => c.path === '/functions/signPdf'));
    expect(h.parse.calls[put]!.headers['x-parse-master-key']).toBe('test-master-key');

    // The next signer's call says nothing of them: the list stands.
    // (Bob signs second and completes the document, so the replacement is shown on a fresh one.)
    const second = await ceremony(h, 'sign', signBody(BOB, pdf('a+b'), pdf('a')));
    expect(second.status).toBe(200);
    expect(h.parse.doc().ScenticRelatedDocuments).toHaveLength(3);

    const WF2 = 'wf-related-2';
    await createWorkflow(h, { ceremony: 'scentic' }, FIRM1, WF2);
    const one = [{ position: 1, total: 1, title: 'Only document' }];
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { relatedDocuments: three, position: 1 }), FIRM1, WF2)).status).toBe(200);
    expect(h.parse.doc('os-doc-2').ScenticRelatedDocuments.map((d: { current?: boolean }) => d.current === true)).toEqual([true, false, false]);
    // No `position`: nothing is marked. A new list replaces the old one whole.
    expect((await ceremony(h, 'sign', signBody(BOB, pdf('a+b'), pdf('a'), { relatedDocuments: one }), FIRM1, WF2)).status).toBe(200);
    expect(h.parse.doc('os-doc-2').ScenticRelatedDocuments).toEqual(one);
  });

  it('sign: forty documents are taken, fifty-one are not; one bad entry, or a bad position, refuses the submission and writes nothing', async () => {
    await createWorkflow(h);
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ position: i + 1, total: n, title: `Document ${i + 1}` }));
    const ok = { position: 1, total: 2, title: 'A' };
    const bad: Array<[unknown, unknown, string]> = [
      [list(MAX_RELATED_DOCUMENTS + 1), undefined, 'relatedDocuments'],
      ['nope', undefined, 'relatedDocuments'],
      [{ 0: ok }, undefined, 'relatedDocuments'],
      [[ok, null], undefined, 'relatedDocuments[1]'],
      [[{ ...ok, title: 'x'.repeat(301) }], undefined, 'relatedDocuments[0].title'],
      [[{ ...ok, title: '<br>' }], undefined, 'relatedDocuments[0].title'],
      [[{ ...ok, title: 7 }], undefined, 'relatedDocuments[0].title'],
      [[{ ...ok, position: 3 }], undefined, 'relatedDocuments[0].position'],
      [[{ ...ok, position: 0 }], undefined, 'relatedDocuments[0].position'],
      [[{ ...ok, position: 1.5 }], undefined, 'relatedDocuments[0].position'],
      [[{ ...ok, position: '1' }], undefined, 'relatedDocuments[0].position'],
      [[{ ...ok, total: 1001 }], undefined, 'relatedDocuments[0].total'],
      [[{ position: 1, title: 'A' }], undefined, 'relatedDocuments[0].total'],
      [[{ ...ok, sha256: 'abc' }], undefined, 'relatedDocuments[0].sha256'],
      [[{ ...ok, sha256: 12 }], undefined, 'relatedDocuments[0].sha256'],
      [[ok], 0, 'position'],
      [[ok], '1', 'position'],
      [[ok], 2.5, 'position'],
      [undefined, -1, 'position'],
    ];
    for (const [relatedDocuments, position, field] of bad) {
      const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { relatedDocuments, position }));
      expect(res.status, field).toBe(400);
      expect(res.body.error.code, field).toBe('INVALID_INPUT');
      expect(res.body.error.details[0].field, JSON.stringify(relatedDocuments)?.slice(0, 80)).toBe(field);
    }
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
    expect(h.parse.doc().ScenticRelatedDocuments).toBeUndefined();

    const forty = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { relatedDocuments: list(40), position: 40 }));
    expect(forty.status).toBe(200);
    const stored = h.parse.doc().ScenticRelatedDocuments;
    expect(stored).toHaveLength(40);
    expect(stored[39]).toEqual({ position: 40, total: 40, title: 'Document 40', current: true });
    expect(stored.filter((d: { current?: boolean }) => d.current)).toHaveLength(1);
  });

  it('sign: bad audit events refuse the submission', async () => {
    await createWorkflow(h);
    const tooMany = Array.from({ length: MAX_AUDIT_EVENTS + 1 }, () => ({ at: '2026-11-19T08:00:00Z', event: 'e', actor: 'a' }));
    for (const auditEvents of [tooMany, 'nope', [{ at: 'yesterday', event: 'e', actor: 'a' }], [{ at: '2026-11-19T08:00:00Z', actor: 'a' }], [{ at: '2026-11-19T08:00:00Z', event: 'e', actor: 'a', ipAddress: 'not-an-ip' }]]) {
      const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { auditEvents }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    }
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
    expect(h.parse.doc().ScenticAudit).toBeUndefined();
  });

  it('sign: a declined or completed document is INVALID_STATE', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'decline', { email: BOB, reason: 'Wrong party named.', ipAddress: '' })).status).toBe(200);
    const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
  });

  it('sign: OpenSign refusing the account is 403, not a retryable upstream error; an outage is retryable', async () => {
    await createWorkflow(h);
    h.parse.failNext('signPdf', 400, { code: 119, error: 'You are not asked to sign this document.' });
    const refused = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN');
    expect(refused.body.error.retryable).toBe(false);
    h.parse.failNext('signPdf', 500, { error: 'boom' });
    const outage = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL));
    expect(outage.status).toBe(502);
    expect(outage.body.error.code).toBe('UPSTREAM_ERROR');
    expect(outage.body.error.retryable).toBe(true);
    expect(outage.body.error.message).not.toContain('boom');
  });

  // ── decline ───────────────────────────────────────────────────────────

  it('decline: declinedoc as that signer; the status names who declined and marks that signer', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'viewed', { email: BOB, ipAddress: '198.51.100.9' })).status).toBe(200);
    const res = await ceremony(h, 'decline', { email: BOB, reason: '  The fee in clause 4 is wrong.  ', ipAddress: '198.51.100.9' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { declined: true } });

    const [call] = callsTo(h, 'declinedoc');
    expect(call!.body).toEqual({ docId: 'os-doc-1', reason: 'The fee in clause 4 is wrong.', userId: 'signer-user-2' });
    expect(call!.headers['x-parse-master-key']).toBe('test-master-key');
    expect(call!.headers['x-parse-session-token']).toBeUndefined();
    expect(call!.headers['x-forwarded-for']).toBe('198.51.100.9');

    const status = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}`, firmId: FIRM1 });
    expect(status.status).toBe(200);
    expect(status.body.data.status).toBe('DECLINED');
    expect(status.body.data.declineReason).toBe('The fee in clause 4 is wrong.');
    expect(status.body.data.declinedByEmail).toBe(BOB);
    expect(status.body.data.signers).toEqual([expect.objectContaining({ email: BOB, status: 'declined' })]);

    const signers = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/signers`, firmId: FIRM1 });
    expect(signers.body.data.signers.map((s: { email: string; state: string }) => [s.email, s.state])).toEqual([[ALICE, 'pending'], [BOB, 'declined']]);

    const poll = await signedRequest(h.app, { method: 'POST', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/poll`, firmId: FIRM1, idempotencyKey: 'p1' });
    expect(poll.body.data).toMatchObject({ status: 'DECLINED', declinedByEmail: BOB, declineReason: 'The fee in clause 4 is wrong.' });
    const pollAgain = await signedRequest(h.app, { method: 'POST', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/poll`, firmId: FIRM1, idempotencyKey: 'p2' });
    expect(pollAgain.body.data).toMatchObject({ status: 'DECLINED', changed: false, declinedByEmail: BOB });
  });

  it('decline: a signer who never opened the document still appears as declined in the status', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'decline', { email: ALICE, reason: 'No.', ipAddress: '' })).status).toBe(200);
    const status = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}`, firmId: FIRM1 });
    expect(status.body.data.declinedByEmail).toBe(ALICE);
    expect(status.body.data.signers).toEqual([{ email: ALICE, status: 'declined' }]);
  });

  it('decline: asked twice by the same signer is the same answer; by another signer afterwards, INVALID_STATE', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'decline', { email: BOB, reason: 'No.', ipAddress: '' })).status).toBe(200);
    const again = await ceremony(h, 'decline', { email: BOB, reason: 'Still no.', ipAddress: '' });
    expect(again.status).toBe(200);
    expect(callsTo(h, 'declinedoc')).toHaveLength(1);
    expect(h.parse.doc().DeclineReason).toBe('No.');
    const other = await ceremony(h, 'decline', { email: ALICE, reason: 'Me too.', ipAddress: '' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('INVALID_STATE');
  });

  it('decline: without a reason, with one too long, not a signer, already signed', async () => {
    await createWorkflow(h);
    for (const reason of [undefined, '', '   ', 7, 'x'.repeat(1001)]) {
      const res = await ceremony(h, 'decline', { email: ALICE, reason, ipAddress: '' });
      expect(res.status, String(reason).slice(0, 10)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.details[0].field).toBe('reason');
    }
    expect((await ceremony(h, 'decline', { email: ALICE, reason: 'x'.repeat(1000), ipAddress: 'nope' })).status).toBe(400);
    const stranger = await ceremony(h, 'decline', { email: 'mallory@example.com', reason: 'No.', ipAddress: '' });
    expect(stranger.status).toBe(404);
    expect(stranger.body.error.code).toBe('NOT_A_SIGNER');
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL))).status).toBe(200);
    const signed = await ceremony(h, 'decline', { email: ALICE, reason: 'Changed my mind.', ipAddress: '' });
    expect(signed.status).toBe(409);
    expect(signed.body.error.code).toBe('ALREADY_SIGNED');
    expect(callsTo(h, 'declinedoc')).toHaveLength(0);
    expect(h.parse.doc().IsDeclined).toBe(false);
  });

  // ── secrets ───────────────────────────────────────────────────────────

  it("no signer's session is ever made, and the master key never appears in a log line, a response or an event, on success or failure", async () => {
    await createWorkflow(h);
    const responses: string[] = [];
    const keep = async (p: Promise<{ text?: string; body: unknown }>) => { const r = await p; responses.push(JSON.stringify(r.body) + (r.text ?? '')); };
    await keep(ceremony(h, 'viewed', { email: ALICE, ipAddress: '198.51.100.4' }));
    // A failure OpenSign answers for (a 4xx): the signer may try again at once. A 5xx would leave
    // the signature in doubt and hold the next attempts back (see "a signature OpenSign never
    // answered for").
    h.parse.failNext('signPdf', 400, { code: 141, error: 'boom r:session-leaked-in-upstream-body' });
    await keep(ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL)));
    h.parse.failNext('signPdf', 400, { code: 119, error: 'refused' });
    await keep(ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL)));
    await keep(ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL)));
    h.parse.failNext('declinedoc', 500, { error: 'boom' });
    await keep(ceremony(h, 'decline', { email: BOB, reason: 'No.', ipAddress: '' }));
    await keep(ceremony(h, 'decline', { email: BOB, reason: 'No.', ipAddress: '' }));
    h.parse.failNext('triggerevent', 500, { error: 'boom' });
    await keep(ceremony(h, 'viewed', { email: ALICE, ipAddress: '' }));

    const tokens = h.parse.tokens().filter((t) => t.startsWith('r:session-'));
    expect(tokens).toEqual([]);
    expect(h.parse.calls.some((c) => c.path === '/loginAs')).toBe(false);
    expect(callsTo(h, 'signPdf').length).toBeGreaterThanOrEqual(3);
    const events = JSON.stringify(await h.outbox.getAll());
    const everything = [...h.logs, ...responses, events].join('\n');
    for (const token of tokens) expect(everything).not.toContain(token);
    expect(everything).not.toContain('r:session-');
    expect(everything).not.toContain('test-master-key');
    // Nor a signer's address in a log line.
    expect(h.logs.join('\n')).not.toContain(ALICE);
    expect(h.logs.join('\n')).not.toContain(BOB);
  });
});

describe("the signer's own name, and OpenSign's page kept out of a ceremony Scentic hosts", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('signerName is required where Scentic hosts the ceremony, and refused when it is not a name', async () => {
    await createWorkflow(h);
    for (const signerName of [undefined, null, '', '   ', 7, 'x'.repeat(201), '<b></b>']) {
      const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signerName }));
      expect(res.status, String(signerName).slice(0, 12)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.details[0].field).toBe('signerName');
    }
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
    expect(h.parse.doc().ScenticSignerNames).toBeUndefined();
  });

  it('it is stored on the document before signPdf, as plain text, beside the other signers’ names — and on no contact or account', async () => {
    await createWorkflow(h);
    const one = pdf('alice');
    expect((await ceremony(h, 'sign', signBody(ALICE, one, ORIGINAL, { signerName: '  Alice <i>Q.</i> Example\n' }))).status).toBe(200);
    expect(h.parse.doc().ScenticSignerNames).toEqual([{ email: ALICE, name: 'Alice Q. Example' }]);
    const put = h.parse.calls.findIndex((c) => c.method === 'PUT' && c.body && 'ScenticSignerNames' in c.body);
    expect(put).toBeGreaterThan(-1);
    expect(put).toBeLessThan(h.parse.calls.findIndex((c) => c.path === '/functions/signPdf'));

    expect((await ceremony(h, 'sign', signBody(BOB, pdf('alice+bob'), one, { signerName: 'Robert Example' }))).status).toBe(200);
    expect(h.parse.doc().ScenticSignerNames).toEqual([
      { email: ALICE, name: 'Alice Q. Example' },
      { email: BOB, name: 'Robert Example' },
    ]);
    // Nothing was ever written to a contact or an account.
    const writes = h.parse.calls.filter((c) => c.method !== 'GET' && (c.path.includes('contracts_Contactbook') || c.path.includes('/classes/_User') || c.path.startsWith('/users')));
    expect(writes).toEqual([]);
    expect(h.parse.contacts().map((c) => c.Name)).toEqual(['Alice', 'Bob']);
  });

  it('a stale submission writes no name', async () => {
    await createWorkflow(h);
    const one = pdf('alice');
    expect((await ceremony(h, 'sign', signBody(ALICE, one, ORIGINAL, { signerName: 'Alice Example' }))).status).toBe(200);
    expect((await ceremony(h, 'sign', signBody(BOB, pdf('bob'), ORIGINAL, { signerName: 'Bob Example' }))).body.error.code).toBe('STALE_DOCUMENT');
    expect(h.parse.doc().ScenticSignerNames).toEqual([{ email: ALICE, name: 'Alice Example' }]);
  });

  it('the ceremony routes are for requests Scentic hosts: on a hosted workflow all four are refused, and nothing reaches the document', async () => {
    await createWorkflow(h, { ceremony: 'hosted', sendInOrder: false });
    const before = h.parse.calls.length;
    const file = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/ceremony/file`, firmId: FIRM1 });
    const answers = [
      file,
      await ceremony(h, 'viewed', { email: ALICE, ipAddress: '' }),
      await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL)),
      await ceremony(h, 'decline', { email: ALICE, reason: 'No.', ipAddress: '' }),
    ];
    for (const res of answers) {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'INVALID_STATE', retryable: false });
      expect(res.body.error.message).toContain('not a Scentic-hosted request');
    }
    expect(h.parse.calls.length).toBe(before);
    expect(h.parse.doc().AuditTrail).toEqual([]);
    // The routes that are for every request still answer.
    const status = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}`, firmId: FIRM1 });
    expect(status.body.data).toMatchObject({ ceremony: 'hosted', status: 'DRAFT' });
  });

  it("a scentic-ceremony document is marked, and no signer's account can open it; a hosted one is as it was", async () => {
    await createWorkflow(h);
    const doc = h.parse.doc();
    expect(doc.ScenticCeremony).toBe(true);
    // Only the platform's own account is on the ACL: the signers linking put there are gone.
    expect(doc.ACL).toEqual({ 'admin-user': { read: true, write: true } });

    const other = harness();
    await createWorkflow(other, { ceremony: 'hosted' });
    expect(other.parse.doc().ScenticCeremony).toBeUndefined();
    expect(Object.keys(other.parse.doc().ACL).sort()).toEqual(['admin-user', 'signer-user-1', 'signer-user-2']);
  });

  it('a signer replaced on a scentic-ceremony document: the new signer is not left on the ACL either', async () => {
    await createWorkflow(h);
    const res = await signedRequest(h.app, {
      method: 'POST', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/signers/replace`,
      bodyObj: { fromEmail: BOB, toEmail: 'carol@example.com', toName: 'Carol' }, firmId: FIRM1, idempotencyKey: 'r1',
    });
    expect(res.status).toBe(200);
    expect(h.parse.doc().ACL).toEqual({ 'admin-user': { read: true, write: true } });
    // And no link to OpenSign's page is handed out for a document it refuses.
    expect(res.body.data).toEqual({ email: 'carol@example.com', signingUrl: '' });
    const signers = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/signers`, firmId: FIRM1 });
    expect(signers.body.data.signers.every((s: { signingUrl?: string }) => s.signingUrl === undefined)).toBe(true);
    expect(signers.body.data.signers.map((s: { email: string }) => s.email)).toEqual([ALICE, 'carol@example.com']);
  });

  it("OpenSign's own page cannot sign, view or decline a scentic-ceremony document, even as a signer on it with a session", async () => {
    await createWorkflow(h);
    // A session for Alice's own account, as OpenSign's page would hold after its code screen —
    // which she can get, because the same account signs another firm's hosted document.
    const login = await h.parse.fetch('http://localhost:8080/app/loginAs', {
      method: 'POST', headers: { 'X-Parse-Application-Id': 'opensign', 'X-Parse-Master-Key': 'test-master-key' }, body: JSON.stringify({ userId: 'signer-user-1' }),
    });
    const { sessionToken } = await login.json() as { sessionToken: string };
    const asAlice = (fn: string, body: unknown) => h.parse.fetch(`http://localhost:8080/app/functions/${fn}`, {
      method: 'POST', headers: { 'X-Parse-Application-Id': 'opensign', 'X-Parse-Session-Token': sessionToken, sessiontoken: sessionToken }, body: JSON.stringify(body),
    });
    const sign = await asAlice('signPdf', { docId: 'os-doc-1', userId: 'contact-1', pdfFile: pdf('x').toString('base64'), signature: PNG_B64 });
    expect(sign.status).toBe(400);
    expect((await sign.json() as { code: number }).code).toBe(119);
    expect((await (await asAlice('triggerevent', { event: 'viewed', contactId: 'contact-1', body: { objectId: 'os-doc-1' } })).json() as { result: { message: string } }).result.message).toBe('User not found!');
    expect((await asAlice('declinedoc', { docId: 'os-doc-1', userId: 'signer-user-1', reason: 'no' })).status).toBe(400);
    expect(h.parse.doc().AuditTrail).toEqual([]);
    expect(h.parse.doc().IsDeclined).toBe(false);
    // The gateway's own submission for her still goes through.
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL))).status).toBe(200);
  });

  it('cross-firm: the name another firm gave an address is not on this firm’s document, and in no response for it', async () => {
    const X = 'x@example.com';
    const create = async (firmId: string, workflowId: string, name: string, firmName: string) => {
      await h.opensignService!.initFirm({ scenticFirmId: firmId, firmName }, 'corr');
      return signedRequest(h.app, {
        method: 'POST', path: `/api/v1/firms/${firmId}/signature/workflows`, firmId, idempotencyKey: `c-${workflowId}`,
        bodyObj: { scenticSignatureWorkflowId: workflowId, scenticDocumentId: 'd', documentName: 'c.pdf', documentBase64: ORIGINAL.toString('base64'), ceremony: 'scentic', signers: [{ scenticSignerId: 's', email: X, name, role: 'signer', order: 1 }] },
      });
    };
    expect((await create(FIRM1, 'wf-a', 'Alice A', 'Firm A')).status).toBe(200);
    const responses: string[] = [];
    const keep = async (p: PromiseLike<{ body: unknown; text?: string; headers: Record<string, string> }>) => {
      const r = await p;
      responses.push(JSON.stringify(r.body) + (r.text ?? '') + JSON.stringify(r.headers));
      return r;
    };
    const b = (method: string, tail: string, bodyObj?: unknown) => signedRequest(h.app, { method, path: `/api/v1/firms/${FIRM2}/signature/workflows/wf-b${tail}`, firmId: FIRM2, bodyObj, idempotencyKey: `b-${tail}-${Math.random()}` });
    expect((await keep(create(FIRM2, 'wf-b', 'Bob B', 'Firm B'))).status).toBe(200);

    // What OpenSign does, which is the reason for all of this: one contact for the address, still
    // carrying the first firm's name, now attached to the second firm's document.
    expect(h.parse.contacts()).toEqual([expect.objectContaining({ Email: X, Name: 'Alice A' })]);
    expect(h.parse.doc('os-doc-2').Signers[0].Name).toBe('Alice A');

    await keep(b('GET', ''));
    await keep(b('GET', '/signers'));
    await keep(b('POST', '/ceremony/viewed', { email: X, ipAddress: '203.0.113.7' }));
    await keep(b('GET', '/ceremony/file'));
    const signed = await keep(b('POST', '/ceremony/sign', signBody(X, pdf('b signed'), ORIGINAL, { signerName: 'Robert B' })));
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ data: { signed: true, completed: true } });
    await keep(b('GET', ''));
    await keep(b('GET', '/signers'));
    await keep(b('POST', '/poll'));
    await keep(b('GET', '/completed'));
    await keep(b('POST', '/remind', { signerEmails: [] }));

    expect(h.parse.doc('os-doc-2').ScenticSignerNames).toEqual([{ email: X, name: 'Robert B' }]);
    expect(h.parse.doc('os-doc-1').ScenticSignerNames).toBeUndefined();
    expect(h.parse.contacts()[0]!.Name).toBe('Alice A');
    const everything = [...responses, JSON.stringify((await h.outbox.getAll()).filter((e) => e.scenticFirmId === FIRM2)), ...h.logs].join('\n');
    expect(everything).not.toContain('Alice A');
    expect(responses.length).toBe(11);
    // Nor does any response carry a name at all for a signer: only addresses and states.
    expect(responses.join('\n')).not.toContain('Bob B');
  });
});

describe("create: the originator's address and the firm's name, for the certificate", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const documentPuts = () => h.parse.calls.filter((c) => c.method === 'PUT' && c.path.startsWith('/classes/contracts_Document/'));

  it('originatorIp is written on the document as OriginIp, with the master key; the firm named at init is its ScenticFirmName', async () => {
    for (const [workflowId, sent, stored] of [['wf-o4', ' 198.51.100.24 ', '198.51.100.24'], ['wf-o6', '2001:db8::8a2e:370:7334', '2001:db8::8a2e:370:7334']] as const) {
      await createWorkflow(h, { ceremony: 'scentic', originatorIp: sent, senderName: 'Dana Levi' }, FIRM1, workflowId);
      const doc = h.parse.doc(`os-doc-${workflowId === 'wf-o4' ? 1 : 2}`);
      expect(doc.OriginIp).toBe(stored);
      // The firm's name as given when the firm was set up, never the platform's.
      expect(doc.ScenticFirmName).toBe('Acme Law');
      expect(doc.FirmName).toBe('Acme Law');
      expect(doc.SenderName).toBe('Dana Levi');
    }
    const put = documentPuts().find((c) => c.body && 'OriginIp' in c.body)!;
    expect(put.headers['x-parse-master-key']).toBe('test-master-key');
    // Not in what createdocumentfromapp is sent: OpenSign would not read it there.
    expect(JSON.stringify(callsTo(h, 'createdocumentfromapp')[0]!.body)).not.toContain('OriginIp');
  });

  it("firmName on create is the certificate's organization; the code email's firm stays the one the firm was set up with; a bad one is refused", async () => {
    await createWorkflow(h, { ceremony: 'scentic', firmName: '  Cohen & Levi <b>Law Offices</b>\n' }, FIRM1, 'wf-renamed');
    expect(h.parse.doc('os-doc-1').ScenticFirmName).toBe('Cohen & Levi Law Offices');
    expect(h.parse.doc('os-doc-1').FirmName).toBe('Acme Law');
    // Nothing usable given: the name from init.
    for (const [i, firmName] of ['', '   ', null, '<br>'].entries()) {
      await createWorkflow(h, { ceremony: 'scentic', firmName }, FIRM1, `wf-unnamed-${i}`);
      expect(h.parse.doc(`os-doc-${i + 2}`).ScenticFirmName, JSON.stringify(firmName)).toBe('Acme Law');
    }
    const uploads = callsTo(h, 'savefile').length;
    for (const [firmName, issue] of [[7, 'not a string'], [['Acme'], 'not a string'], ['x'.repeat(201), 'at most 200 characters']] as const) {
      const res = await signedRequest(h.app, {
        method: 'POST',
        path: `/api/v1/firms/${FIRM1}/signature/workflows`,
        bodyObj: {
          scenticSignatureWorkflowId: 'wf-bad-firm', scenticDocumentId: 'doc-1', documentName: 'contract.pdf', documentBase64: ORIGINAL.toString('base64'),
          signers: [{ scenticSignerId: 's1', email: ALICE, name: 'Alice', role: 'signer', order: 1 }],
          ceremony: 'scentic', firmName,
        },
        firmId: FIRM1,
        idempotencyKey: `bad-firm-${Math.random()}`,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toMatchObject({ field: 'firmName', issue });
    }
    expect(callsTo(h, 'savefile')).toHaveLength(uploads);
  });

  it("senderEmail is written on the document as SenderMail, lowercased, with the master key; without it nothing is written for it; a bad one is refused", async () => {
    await createWorkflow(h, { ceremony: 'scentic', senderEmail: ' Dana.Levi@CohenLevi.example ', senderName: 'Dana Levi' }, FIRM1, 'wf-sender');
    expect(h.parse.doc('os-doc-1').SenderMail).toBe('dana.levi@cohenlevi.example');
    const put = documentPuts().find((c) => c.body && 'SenderMail' in c.body)!;
    expect(put.headers['x-parse-master-key']).toBe('test-master-key');
    expect(JSON.stringify(callsTo(h, 'createdocumentfromapp')[0]!.body)).not.toContain('SenderMail');
    // The gateway itself mails nobody at that address: it is on the document and nowhere else.
    expect(JSON.stringify(h.parse.calls.filter((c) => c.path.startsWith('/functions/sendmail')))).not.toContain('dana.levi@');

    for (const [i, senderEmail] of ['', '  ', null].entries()) {
      await createWorkflow(h, { ceremony: 'scentic', senderEmail }, FIRM1, `wf-nosender-${i}`);
      expect('SenderMail' in h.parse.doc(`os-doc-${i + 2}`)).toBe(false);
    }
    const uploads = callsTo(h, 'savefile').length;
    const long = `${'a'.repeat(64)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example`;
    expect(long.length).toBeGreaterThan(254);
    for (const senderEmail of ['dana', 'dana@', '@firm.example', 'dana@firm', 'Dana Levi <dana@firm.example>', 'dana@firm.example, eve@x.example', 'dana @firm.example', 'dana@firm.example\nBcc: eve@x.example', 'dana@fïrm.example', long, 7, ['dana@firm.example'], { email: 'dana@firm.example' }]) {
      const res = await signedRequest(h.app, {
        method: 'POST',
        path: `/api/v1/firms/${FIRM1}/signature/workflows`,
        bodyObj: {
          scenticSignatureWorkflowId: 'wf-bad-sender', scenticDocumentId: 'doc-1', documentName: 'contract.pdf', documentBase64: ORIGINAL.toString('base64'),
          signers: [{ scenticSignerId: 's1', email: ALICE, name: 'Alice', role: 'signer', order: 1 }],
          ceremony: 'scentic', senderEmail,
        },
        firmId: FIRM1,
        idempotencyKey: `bad-sender-${Math.random()}`,
      });
      expect(res.status, JSON.stringify(senderEmail)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.details[0]).toMatchObject({ field: 'senderEmail', issue: 'not an email address' });
    }
    expect(callsTo(h, 'savefile')).toHaveLength(uploads);
    // Exactly 254 characters is taken.
    const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(53)}.example`;
    expect(longest.length).toBe(254);
    await createWorkflow(h, { ceremony: 'scentic', senderEmail: longest }, FIRM1, 'wf-longest');
    expect(h.parse.doc('os-doc-5').SenderMail).toBe(longest);
  });

  it('without originatorIp, or with an empty one, nothing is written for it; a hosted request takes it too', async () => {
    await createWorkflow(h, { ceremony: 'scentic' }, FIRM1, 'wf-none');
    await createWorkflow(h, { ceremony: 'scentic', originatorIp: '' }, FIRM1, 'wf-empty');
    await createWorkflow(h, { originatorIp: null }, FIRM1, 'wf-null');
    for (const put of documentPuts()) expect(put.body && 'OriginIp' in put.body).toBe(false);
    expect(h.parse.doc('os-doc-1').ScenticFirmName).toBe('Acme Law');
    await createWorkflow(h, { originatorIp: '203.0.113.9' }, FIRM1, 'wf-hosted');
    expect(h.parse.doc('os-doc-4').OriginIp).toBe('203.0.113.9');
    expect(h.parse.doc('os-doc-4').ScenticCeremony).toBeUndefined();
  });

  it('anything that is not one IP address is refused before anything is uploaded or created', async () => {
    await h.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    for (const originatorIp of ['203.0.113.7, 10.0.0.1', '203.0.113.7:443', 'example.com', '[::1]', 'unknown', 7, { ip: '1.2.3.4' }, ['1.2.3.4']]) {
      const res = await signedRequest(h.app, {
        method: 'POST',
        path: `/api/v1/firms/${FIRM1}/signature/workflows`,
        bodyObj: {
          scenticSignatureWorkflowId: 'wf-bad-ip', scenticDocumentId: 'doc-1', documentName: 'contract.pdf', documentBase64: ORIGINAL.toString('base64'),
          signers: [{ scenticSignerId: 's1', email: ALICE, name: 'Alice', role: 'signer', order: 1 }],
          ceremony: 'scentic', originatorIp,
        },
        firmId: FIRM1,
        idempotencyKey: `bad-ip-${Math.random()}`,
      });
      expect(res.status, JSON.stringify(originatorIp)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.details[0]).toMatchObject({ field: 'originatorIp', issue: 'not an IP address' });
    }
    expect(callsTo(h, 'savefile')).toHaveLength(0);
    expect(callsTo(h, 'createdocumentfromapp')).toHaveLength(0);
  });
});

describe('create: where the signers sign', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const created = (h: Harness) => callsTo(h, 'createdocumentfromapp')[0]!.body!.document as Record<string, unknown>;

  it("ceremony 'scentic': OpenSign orders nothing whatever sendInOrder says, mails nobody, and the mapping remembers", async () => {
    const h = harness();
    const res = await createWorkflow(h, { ceremony: 'scentic', sendInOrder: true, sendNow: true });
    expect(res.body.data.ceremony).toBe('scentic');
    expect(created(h).SendinOrder).toBe(false);
    expect(created(h).SendInOrderStrict).toBe(false);
    expect(created(h).AutomaticReminders).toBe(false);
    expect(created(h).IsEnableOTP).toBe(true);
    expect(callsTo(h, 'sendmailv3')).toHaveLength(0);
    expect(h.parse.doc().RequestBody).toContain('data-scentic-delivers');
    expect((await h.store.getOpenSignWorkflowMapping(FIRM1, WF))!.ceremony).toBe('scentic');

    const status = await signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}`, firmId: FIRM1 });
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ status: 'DRAFT', ceremony: 'scentic', declinedByEmail: '', declineReason: null });
  });

  it("ceremony 'hosted' is today's call, byte for byte, and so is leaving it out", async () => {
    const run = async (extra: Record<string, unknown>) => {
      // The same sequence each run, so the ids OpenSign's placeholders are given are the same.
      let seed = 1;
      vi.spyOn(Math, 'random').mockImplementation(() => {
        seed = (seed * 48271) % 2147483647;
        return seed / 2147483647;
      });
      const h = harness();
      const res = await createWorkflow(h, { sendInOrder: true, sendNow: true, ...extra });
      const sent = h.parse.calls.map((c) => JSON.stringify([c.method, c.path, c.body]));
      const mapping = await h.store.getOpenSignWorkflowMapping(FIRM1, WF);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      return { sent, ceremony: res.body.data.ceremony, mapping, document: sent.find((s) => s.includes('createdocumentfromapp'))! };
    };
    const omitted = await run({});
    const hosted = await run({ ceremony: 'hosted' });
    expect(hosted.sent).toEqual(omitted.sent);
    expect(hosted.ceremony).toBe('hosted');
    expect(omitted.ceremony).toBe('hosted');
    expect(omitted.mapping!.ceremony).toBe('hosted');
    // And it is the ordered, strict, invited document it was before `ceremony` existed.
    const document = JSON.parse(omitted.document)[2].document;
    expect(document.SendinOrder).toBe(true);
    expect(document.SendInOrderStrict).toBe(true);
    expect(document.AutomaticReminders).toBe(true);
    expect(Object.keys(document)).toEqual([
      'Name', 'URL', 'Type', 'ExtUserPtr', 'CreatedBy', 'Signers', 'Placeholders', 'TimeToCompleteDays',
      'SendinOrder', 'SendInOrderStrict', 'IsEnableOTP', 'NotifyOnSignatures', 'AutomaticReminders', 'RemindOnceInEvery',
    ]);
    // In order, only the first signer is invited by the gateway.
    expect(omitted.sent.filter((s) => s.includes('/functions/sendmailv3'))).toHaveLength(1);
  });

  it('a ceremony that is neither is refused, not guessed', async () => {
    const h = harness();
    await h.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    const res = await signedRequest(h.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/signature/workflows`,
      bodyObj: { scenticSignatureWorkflowId: 'wf-x', scenticDocumentId: 'd', documentName: 'c.pdf', documentBase64: ORIGINAL.toString('base64'), signers: [{ email: ALICE }], ceremony: 'Scentic' },
      firmId: FIRM1,
      idempotencyKey: 'bad-ceremony',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
    expect(callsTo(h, 'createdocumentfromapp')).toHaveLength(0);
  });

  it('capabilities name the ceremony, signing at once, and who declined', () => {
    expect(SIGNATURE_CAPABILITIES).toMatchObject({
      scenticCeremony: 'emulated',
      concurrentSigning: 'emulated',
      parallelSigning: 'supported',
      perSignerDecline: 'supported',
      certificateEventHistory: 'supported',
      signerConfirmedName: 'supported',
    });
  });
});

describe('the stored mapping remembers the ceremony (SQLite)', () => {
  const params = (id: string, ceremony?: 'hosted' | 'scentic') => ({
    scenticFirmId: FIRM1, scenticSignatureWorkflowId: id, scenticMatterId: 'm', scenticDocumentId: 'd', scenticDocumentVersionId: 'v',
    scenticPhysicalFileId: 'p', documentName: 'c.pdf', documentBase64: '', signers: [], sendNow: false, ...(ceremony ? { ceremony } : {}),
  });

  it('a new database stores and reads it back; left out, it is hosted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-ceremony-'));
    try {
      const store = new SqliteMappingStore(join(dir, 'a.db'));
      expect((await store.upsertOpenSignWorkflowMapping(params('w1', 'scentic'), 'os1', 'os1', 'DRAFT')).ceremony).toBe('scentic');
      await store.upsertOpenSignWorkflowMapping(params('w2'), 'os2', 'os2', 'DRAFT');
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'w1'))!.ceremony).toBe('scentic');
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'w2'))!.ceremony).toBe('hosted');
      // A status update leaves it alone.
      await store.updateOpenSignWorkflowStatus(FIRM1, 'w1', 'SENT');
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'w1'))!.ceremony).toBe('scentic');
      store.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a database made before the column existed gains it, and its workflows read as hosted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-ceremony-'));
    try {
      const path = join(dir, 'old.db');
      const old = new Database(path);
      old.exec(`CREATE TABLE opensign_workflow_mappings (
        id TEXT PRIMARY KEY, scentic_firm_id TEXT NOT NULL, scentic_signature_workflow_id TEXT NOT NULL, scentic_matter_id TEXT NOT NULL,
        scentic_document_id TEXT NOT NULL, scentic_document_version_id TEXT NOT NULL, opensign_document_id TEXT NOT NULL,
        opensign_workflow_id TEXT NOT NULL, opensign_status TEXT NOT NULL DEFAULT 'DRAFT', status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(scentic_firm_id, scentic_signature_workflow_id));
        INSERT INTO opensign_workflow_mappings VALUES ('1', '${FIRM1}', 'old-wf', 'm', 'd', 'v', 'os', 'os', 'SENT', 'ACTIVE', '2026-01-01', '2026-01-01');`);
      old.close();
      const store = new SqliteMappingStore(path);
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'old-wf'))!.ceremony).toBe('hosted');
      expect((await store.upsertOpenSignWorkflowMapping(params('new-wf', 'scentic'), 'os3', 'os3', 'DRAFT')).ceremony).toBe('scentic');
      // And the columns for a signature in doubt, on the old row as on the new.
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'old-wf'))!.signInDoubtUntil).toBeNull();
      await store.setOpenSignWorkflowSignInDoubt(FIRM1, 'old-wf', { until: '2026-11-20T10:00:00.000Z', sha256: 'ab'.repeat(32) });
      expect(await store.getOpenSignWorkflowMapping(FIRM1, 'old-wf')).toMatchObject({ signInDoubtUntil: '2026-11-20T10:00:00.000Z', signInDoubtSha: 'ab'.repeat(32) });
      store.close();
      // Opened a second time: the column is not added twice.
      const again = new SqliteMappingStore(path);
      expect((await again.getOpenSignWorkflowMapping(FIRM1, 'new-wf'))!.ceremony).toBe('scentic');
      again.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Against a real PostgreSQL, when one is named: CONTRACT_POSTGRES_URL=postgres://user:pass@host:port/db
// (an empty, throwaway database — the test creates and drops its own tables' rows).
const POSTGRES_URL = process.env.CONTRACT_POSTGRES_URL;
describe.skipIf(!POSTGRES_URL)('the stored mapping remembers the ceremony (PostgreSQL; requires CONTRACT_POSTGRES_URL)', () => {
  it('the schema applies twice, an older table gains the column, and the ceremony is stored and read back', async () => {
    const { PostgresMappingStore } = await import('../storage/postgres-store.js');
    const pg = await import('pg');
    const raw = new pg.default.Pool({ connectionString: POSTGRES_URL });
    // The table as it was before the column existed, with one workflow in it.
    await raw.query('DROP TABLE IF EXISTS opensign_workflow_mappings');
    await raw.query(`CREATE TABLE opensign_workflow_mappings (
      id TEXT PRIMARY KEY, scentic_firm_id TEXT NOT NULL, scentic_signature_workflow_id TEXT NOT NULL, scentic_matter_id TEXT NOT NULL,
      scentic_document_id TEXT NOT NULL, scentic_document_version_id TEXT NOT NULL, opensign_document_id TEXT NOT NULL,
      opensign_workflow_id TEXT NOT NULL, opensign_status TEXT NOT NULL DEFAULT 'DRAFT', status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(scentic_firm_id, scentic_signature_workflow_id))`);
    await raw.query(`INSERT INTO opensign_workflow_mappings (id, scentic_firm_id, scentic_signature_workflow_id, scentic_matter_id, scentic_document_id, scentic_document_version_id, opensign_document_id, opensign_workflow_id, opensign_status) VALUES ('1', $1, 'old-wf', 'm', 'd', 'v', 'os', 'os', 'SENT')`, [FIRM1]);

    const store = new PostgresMappingStore(POSTGRES_URL!, 'disable');
    try {
      await store.initSchema();
      await store.initSchema();
      const params = (id: string, ceremony?: 'hosted' | 'scentic') => ({
        scenticFirmId: FIRM1, scenticSignatureWorkflowId: id, scenticMatterId: 'm', scenticDocumentId: 'd', scenticDocumentVersionId: 'v',
        scenticPhysicalFileId: 'p', documentName: 'c.pdf', documentBase64: '', signers: [], sendNow: false, ...(ceremony ? { ceremony } : {}),
      });
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'old-wf'))!.ceremony).toBe('hosted');
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'old-wf'))!.signInDoubtUntil).toBeNull();
      await store.setOpenSignWorkflowSignInDoubt(FIRM1, 'old-wf', { until: '2026-11-20T10:00:00.000Z', sha256: 'ab'.repeat(32) });
      expect(await store.getOpenSignWorkflowMapping(FIRM1, 'old-wf')).toMatchObject({ signInDoubtUntil: '2026-11-20T10:00:00.000Z', signInDoubtSha: 'ab'.repeat(32) });
      await store.setOpenSignWorkflowSignInDoubt(FIRM1, 'old-wf', null);
      expect((await store.getOpenSignWorkflowMapping(FIRM1, 'old-wf'))!.signInDoubtSha).toBeNull();
      expect((await store.upsertOpenSignWorkflowMapping(params('pg-scentic', 'scentic'), 'os1', 'os1', 'DRAFT')).ceremony).toBe('scentic');
      expect((await store.upsertOpenSignWorkflowMapping(params('pg-hosted'), 'os2', 'os2', 'DRAFT')).ceremony).toBe('hosted');
      await store.updateOpenSignWorkflowStatus(FIRM1, 'pg-scentic', 'SENT');
      const read = await store.getOpenSignWorkflowMapping(FIRM1, 'pg-scentic');
      expect(read).toMatchObject({ ceremony: 'scentic', opensignStatus: 'SENT', opensignDocumentId: 'os1' });
      // Created again (the idempotent path writes the same row): the ceremony it was made with stands.
      expect((await store.upsertOpenSignWorkflowMapping(params('pg-scentic', 'hosted'), 'os1', 'os1', 'SENT')).ceremony).toBe('scentic');
      expect((await store.listOpenSignWorkflowMappings(FIRM1)).map((m) => m.ceremony).sort()).toEqual(['hosted', 'hosted', 'scentic']);
    } finally {
      await store.close();
      await raw.end();
    }
  });
});

describe('review round: retries, the lock across instances, time limits, the picture, the date', () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  // ── R1 ──
  it("the last signer's retry after a lost answer hears ALREADY_SIGNED, not that the document is closed", async () => {
    await createWorkflow(h);
    const one = pdf('alice');
    const two = pdf('alice+bob');
    expect((await ceremony(h, 'sign', signBody(ALICE, one, ORIGINAL))).status).toBe(200);
    const last = await ceremony(h, 'sign', signBody(BOB, two, one));
    expect(last.body.data.completed).toBe(true);
    // The same submission again, as a caller that never saw the answer would send it.
    for (const email of [BOB, ALICE]) {
      const again = await ceremony(h, 'sign', signBody(email, two, one));
      expect(again.status, email).toBe(409);
      expect(again.body.error, email).toMatchObject({ code: 'ALREADY_SIGNED', retryable: false });
    }
    expect(callsTo(h, 'signPdf')).toHaveLength(2);
    // Somebody who never signed is still told the document is closed.
    const stranger = await ceremony(h, 'sign', signBody('mallory@example.com', two, one));
    expect(stranger.body.error.code).toBe('INVALID_STATE');
  });

  it('a signer who signed, on a document then declined by another: ALREADY_SIGNED for them, to sign or to decline; the decliner asking again is still answered yes', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('alice'), ORIGINAL))).status).toBe(200);
    expect((await ceremony(h, 'decline', { email: BOB, reason: 'No.', ipAddress: '' })).status).toBe(200);
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('x'), ORIGINAL))).body.error.code).toBe('ALREADY_SIGNED');
    expect((await ceremony(h, 'decline', { email: ALICE, reason: 'Late.', ipAddress: '' })).body.error.code).toBe('ALREADY_SIGNED');
    expect((await ceremony(h, 'decline', { email: BOB, reason: 'No.', ipAddress: '' })).status).toBe(200);
    expect(callsTo(h, 'declinedoc')).toHaveLength(1);
  });

  // ── R2 ──
  it("every submission runs inside the store's lock for its workflow, and only one at a time", async () => {
    await createWorkflow(h);
    const keys: string[] = [];
    let inside = 0;
    let most = 0;
    const real = h.store.withWorkflowLock.bind(h.store);
    h.store.withWorkflowLock = async (key, fn, options) => {
      keys.push(key);
      inside++;
      most = Math.max(most, inside);
      try { return await real(key, fn, options); } finally { inside--; }
    };
    h.parse.signDelayMs = 30;
    await Promise.all([
      ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL)),
      ceremony(h, 'viewed', { email: BOB, ipAddress: '' }),
      ceremony(h, 'decline', { email: 'mallory@example.com', reason: 'No.', ipAddress: '' }),
    ]);
    expect(keys).toEqual([`${FIRM1}:${WF}`, `${FIRM1}:${WF}`, `${FIRM1}:${WF}`]);
    expect(most).toBe(1);
  });

  it('when another instance holds the lock too long the answer is a retryable 409 BUSY, and nothing was read or written', async () => {
    await createWorkflow(h);
    const before = h.parse.calls.length;
    h.store.withWorkflowLock = async () => { throw new WorkflowLockBusy(); };
    for (const res of [
      await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL)),
      await ceremony(h, 'viewed', { email: ALICE, ipAddress: '' }),
      await ceremony(h, 'decline', { email: ALICE, reason: 'No.', ipAddress: '' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'BUSY', retryable: true });
    }
    expect(h.parse.calls.length).toBe(before);
    // Any other failure of the store is not dressed up as busy.
    h.store.withWorkflowLock = async () => { throw new Error('database gone'); };
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL))).status).toBe(500);
  });

  it('an OpenSign that never answers is given up on: a retryable upstream error, and the lock is free for the next call', async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    h = harness({ signMs: 60, otherMs: 40 });
    await createWorkflow(h);
    for (const [fn, action, body] of [
      ['signPdf', 'sign', signBody(ALICE, pdf('a'), ORIGINAL)],
      ['triggerevent', 'viewed', { email: ALICE, ipAddress: '' }],
      ['declinedoc', 'decline', { email: BOB, reason: 'No.', ipAddress: '' }],
    ] as const) {
      h.parse.hang = fn;
      const started = Date.now();
      const res = await ceremony(h, action, body);
      expect(res.status, fn).toBe(502);
      expect(res.body.error, fn).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
      expect(Date.now() - started, fn).toBeLessThan(2000);
    }
    h.parse.hang = null;
    // The lock is free: the next call is answered at once. (What it is answered after an
    // unanswered signature is the subject of the "in doubt" tests below.)
    const next = await ceremony(h, 'viewed', { email: ALICE, ipAddress: '' });
    expect(next.status).toBe(200);
  });

  it('reads and writes are given up on too: the document read, the file, a record write', async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    h = harness({ readMs: 40, fileMs: 60 });
    await createWorkflow(h);
    const file = () => signedRequest(h.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/ceremony/file`, firmId: FIRM1 });
    for (const [what, call] of [
      ['getDocument', file],
      ['getsignedurl', file],
      ['file', file],
      ['rest', () => expiry(h, inDays(5))],
    ] as const) {
      h.parse.hang = what;
      const started = Date.now();
      const res = await call();
      expect(res.status, what).toBe(502);
      expect(res.body.error, what).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
      expect(Date.now() - started, what).toBeLessThan(2000);
    }
    h.parse.hang = null;
    expect((await file()).status).toBe(200);
  });

  it('more of what a PNG can carry: animation and unknown chunks are refused, a description is allowed, nothing follows the end', async () => {
    const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v, 4 * i)); return b; };
    const fcTL = Buffer.concat([u32(0, 20000, 20000, 0, 0), Buffer.from([0, 1, 0, 1, 0, 0])]);
    const refused: Array<[string, Buffer]> = [
      ['an animated PNG whose frames declare 20000 x 20000', makePng(10, 10, { extra: [chunk('acTL', u32(1, 0)), chunk('fcTL', fcTL)] })],
      ['a frame chunk alone', makePng(10, 10, { extra: [chunk('fcTL', fcTL)] })],
      ['frame data', makePng(10, 10, { extra: [chunk('fdAT', Buffer.alloc(8))] })],
      ['a critical chunk nobody knows', makePng(10, 10, { extra: [chunk('XYZW', Buffer.alloc(4))] })],
      ["Apple's non-standard chunk", makePng(10, 10, { extra: [chunk('CgBI', Buffer.alloc(4))] })],
      ['an ancillary chunk not on the list', makePng(10, 10, { extra: [chunk('eXIf', Buffer.alloc(16))] })],
      ['a second header', makePng(10, 10, { extra: [chunk('IHDR', Buffer.alloc(13))] })],
      ['bytes after the end', makePng(10, 10, { after: Buffer.from('trailing') })],
      ['a whole second picture after the end', makePng(10, 10, { after: makePng(10, 10).subarray(8) })],
      ['an end chunk with something in it', makePng(10, 10, { endData: Buffer.from('x') })],
      ['text over 64 KB', makePng(10, 10, { extra: [chunk('tEXt', Buffer.alloc(MAX_PNG_TEXT_BYTES + 1, 0x41))] })],
      ['text over 64 KB in pieces', makePng(10, 10, { extra: [chunk('iTXt', Buffer.alloc(40_000, 0x41)), chunk('zTXt', Buffer.alloc(20_000, 0x41)), chunk('iCCP', Buffer.alloc(6_000, 0x41))] })],
    ];
    const corrupt = makePng(10, 10, { extra: [chunk('sRGB', Buffer.from([0]))] });
    corrupt[8 + 25 + 8] ^= 0xff; // one byte of the sRGB chunk: its checksum no longer matches
    refused.push(['a chunk whose checksum is wrong', corrupt]);
    const tooLong = makePng(10, 10);
    tooLong.writeUInt32BE(0x7fffffff, 8 + 25); // the IDAT chunk says it is two gigabytes long
    refused.push(['a chunk longer than the file', tooLong]);
    for (const [what, bytes] of refused) expect(pngProblem(bytes), what).toBe('not a valid PNG');

    // What a browser's canvas writes: a colour space, a pixel density, sometimes a little text.
    const canvas = makePng(300, 100, { extra: [chunk('sRGB', Buffer.from([0])), chunk('gAMA', u32(45455)), chunk('pHYs', Buffer.concat([u32(3780, 3780), Buffer.from([1])])), chunk('tEXt', Buffer.from('Software\0canvas'))] });
    expect(pngProblem(canvas)).toBeNull();
    expect(pngProblem(makePng(16, 16, { colour: 3, depth: 8, extra: [chunk('PLTE', Buffer.alloc(6)), chunk('tRNS', Buffer.alloc(2))] }))).toBeNull();
    expect(pngProblem(makePng(10, 10, { extra: [chunk('tEXt', Buffer.alloc(MAX_PNG_TEXT_BYTES, 0x41))] }))).toBeNull();

    await createWorkflow(h);
    const apng = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signaturePngBase64: refused[0]![1].toString('base64') }));
    expect(apng.status).toBe(400);
    expect(apng.body.error.details[0]).toMatchObject({ field: 'signaturePngBase64', issue: 'not a valid PNG' });
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signaturePngBase64: canvas.toString('base64') }))).status).toBe(200);
  });

  it('the checksum is the one PNG uses', () => {
    expect(crc32(Buffer.from('IEND', 'latin1'))).toBe(0xae426082);
    expect(crc32(Buffer.from('123456789', 'latin1'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  // ── R3 ──
  it('a signature picture is refused unless it is a sound PNG no larger than 2400 × 1200, before anything reaches OpenSign', async () => {
    await createWorkflow(h);
    const cases: Array<[string, Buffer, string]> = [
      ['too wide', makePng(2401, 10), 'image too large'],
      ['too tall', makePng(10, 1201), 'image too large'],
      ['enormous', makePng(60000, 60000, { pixels: Buffer.alloc(16) }), 'image too large'],
      ['header of the wrong length', makePng(10, 10, { ihdrLength: 14 }), 'not a valid PNG'],
      ['no width', makePng(0, 10, { pixels: Buffer.alloc(10) }), 'not a valid PNG'],
      ['no height', makePng(10, 0, { pixels: Buffer.alloc(10) }), 'not a valid PNG'],
      ['a bit depth PNG does not have', makePng(10, 10, { depth: 3 }), 'not a valid PNG'],
      ['a depth its colour type does not allow', makePng(10, 10, { colour: 2, depth: 4 }), 'not a valid PNG'],
      ['a colour type PNG does not have', makePng(10, 10, { colour: 5 }), 'not a valid PNG'],
      ['a header whose checksum is wrong', makePng(10, 10, { badCrc: true }), 'not a valid PNG'],
      ['interlaced', makePng(10, 10, { interlace: 1 }), 'not a valid PNG'],
      ['no picture data', makePng(10, 10, { noData: true }), 'not a valid PNG'],
      ['no end', makePng(10, 10, { noEnd: true }), 'not a valid PNG'],
      ['cut short', makePng(10, 10).subarray(0, 40), 'not a valid PNG'],
      ['only the first bytes of one', PNG_MAGIC, 'not a valid PNG'],
      // Says ten by ten; holds five megabytes. The cap on inflating catches it, not memory.
      ['more picture than it says', makePng(10, 10, { pixels: Buffer.alloc(5 * 1024 * 1024) }), 'image too large'],
      ['less picture than it says', makePng(10, 10, { pixels: Buffer.alloc(7) }), 'not a valid PNG'],
    ];
    for (const [what, bytes, issue] of cases) {
      expect(bytes.length, what).toBeLessThan(1024 * 1024);
      const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signaturePngBase64: bytes.toString('base64') }));
      expect(res.status, what).toBe(400);
      expect(res.body.error.code, what).toBe('INVALID_INPUT');
      expect(res.body.error.details[0], what).toMatchObject({ field: 'signaturePngBase64', issue });
    }
    expect(callsTo(h, 'signPdf')).toHaveLength(0);
    expect(h.parse.doc().ScenticSignerNames).toBeUndefined();
  });

  it('sound pictures of every kind PNG has are taken, at the largest size allowed', async () => {
    for (const [colour, depth] of [[0, 1], [0, 16], [2, 8], [3, 4], [4, 8], [6, 8], [6, 16]] as const) {
      expect(pngProblem(makePng(64, 32, { colour, depth })), `${colour}/${depth}`).toBeNull();
    }
    expect(pngProblem(makePng(2400, 1200, { colour: 0, depth: 1 }))).toBeNull();
    await createWorkflow(h);
    const res = await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL, { signaturePngBase64: makePng(2400, 1200, { colour: 0, depth: 1 }).toString('base64') }));
    expect(res.status).toBe(200);
  });

  // ── R5 ──
  const expiry = (hh: Harness, expiresAt: unknown, workflowId = WF, firmId = FIRM1, signedAs = firmId) =>
    signedRequest(hh.app, { method: 'POST', path: `/api/v1/firms/${firmId}/signature/workflows/${workflowId}/expiry`, bodyObj: { expiresAt }, firmId: signedAs, idempotencyKey: `e-${Math.random()}` });
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
  const statusOf = (hh: Harness) => signedRequest(hh.app, { method: 'GET', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}`, firmId: FIRM1 });

  it("expiry: sets the date OpenSign reads, with the master key, and the status reports it — for either ceremony", async () => {
    for (const ceremonyKind of ['scentic', 'hosted']) {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      h = harness();
      await createWorkflow(h, { ceremony: ceremonyKind });
      const when = inDays(40);
      const res = await expiry(h, when);
      expect(res.status, ceremonyKind).toBe(200);
      expect(res.body).toEqual({ ok: true, data: { expiresAt: when } });
      const put = h.parse.calls.filter((c) => c.method === 'PUT' && c.body && 'ExpiryDate' in c.body);
      expect(put).toHaveLength(1);
      expect(put[0]!.body).toEqual({ ExpiryDate: { __type: 'Date', iso: when } });
      expect(put[0]!.headers['x-parse-master-key']).toBe('test-master-key');
      expect((await statusOf(h)).body.data.expiresAt).toBe(when);
    }
  });

  it('expiry: a time with an offset is stored in UTC', async () => {
    await createWorkflow(h);
    const local = new Date(Date.now() + 10 * 86_400_000);
    local.setUTCMilliseconds(0);
    const withOffset = new Date(local.getTime() + 2 * 3_600_000).toISOString().replace('.000Z', '+02:00');
    const res = await expiry(h, withOffset);
    expect(res.status).toBe(200);
    expect(res.body.data.expiresAt).toBe(local.toISOString());
  });

  it('expiry: a request that has lapsed but is otherwise still out is given more time, and can then be signed', async () => {
    await createWorkflow(h);
    h.parse.doc().ExpiryDate = { __type: 'Date', iso: new Date(Date.now() - 86_400_000).toISOString() };
    expect((await statusOf(h)).body.data.status).toBe('EXPIRED');
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL))).body.error.code).toBe('INVALID_STATE');
    // Lapsed, polling had stopped looking at it.
    expect((await h.store.getOpenSignWorkflowMapping(FIRM1, WF))!.opensignStatus).toBe('EXPIRED');

    expect((await expiry(h, inDays(7))).status).toBe(200);
    expect((await h.store.getOpenSignWorkflowMapping(FIRM1, WF))!.opensignStatus).toBe('DRAFT');
    expect((await statusOf(h)).body.data.status).toBe('DRAFT');
    expect((await ceremony(h, 'sign', signBody(ALICE, pdf('a'), ORIGINAL))).status).toBe(200);
    const poll = await signedRequest(h.app, { method: 'POST', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/poll`, firmId: FIRM1, idempotencyKey: 'pe' });
    expect(poll.body.data).toMatchObject({ status: 'IN_PROGRESS', changed: true });
  });

  it('expiry: not in the past, not more than 365 days out, not anything but a full date and time', async () => {
    await createWorkflow(h);
    for (const [value, issue] of [
      [undefined, 'not an ISO 8601 date and time with a time zone'],
      [1893456000000, 'not an ISO 8601 date and time with a time zone'],
      ['next friday', 'not an ISO 8601 date and time with a time zone'],
      ['2027-01-01', 'not an ISO 8601 date and time with a time zone'],
      ['2027-01-01T10:00:00', 'not an ISO 8601 date and time with a time zone'],
      ['2027-13-45T10:00:00Z', 'not a date'],
      [new Date(Date.now() - 1000).toISOString(), 'must be in the future'],
      [inDays(366), 'at most 365 days from now'],
    ] as const) {
      const res = await expiry(h, value);
      expect(res.status, String(value)).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
      expect(res.body.error.details, String(value)).toEqual([{ field: 'expiresAt', issue }]);
    }
    expect((await expiry(h, inDays(364))).status).toBe(200);
    expect(h.parse.calls.filter((c) => c.method === 'PUT' && c.body && 'ExpiryDate' in c.body)).toHaveLength(1);
  });

  it('expiry: a request that is completed, declined or withdrawn cannot be given more time', async () => {
    await createWorkflow(h);
    expect((await ceremony(h, 'decline', { email: BOB, reason: 'No.', ipAddress: '' })).status).toBe(200);
    const declined = await expiry(h, inDays(5));
    expect(declined.status).toBe(409);
    expect(declined.body.error).toMatchObject({ code: 'INVALID_STATE', retryable: false });

    vi.unstubAllGlobals(); vi.restoreAllMocks(); h = harness();
    await createWorkflow(h);
    const one = pdf('a');
    await ceremony(h, 'sign', signBody(ALICE, one, ORIGINAL));
    await ceremony(h, 'sign', signBody(BOB, pdf('ab'), one));
    expect((await expiry(h, inDays(5))).body.error.code).toBe('INVALID_STATE');

    vi.unstubAllGlobals(); vi.restoreAllMocks(); h = harness();
    await createWorkflow(h);
    await signedRequest(h.app, { method: 'POST', path: `/api/v1/firms/${FIRM1}/signature/workflows/${WF}/cancel`, bodyObj: { reason: 'x' }, firmId: FIRM1, idempotencyKey: 'cx' });
    expect((await expiry(h, inDays(5))).body.error.code).toBe('INVALID_STATE');
    // Withdrawn in OpenSign without the gateway knowing.
    vi.unstubAllGlobals(); vi.restoreAllMocks(); h = harness();
    await createWorkflow(h);
    h.parse.doc().IsArchive = true;
    expect((await expiry(h, inDays(5))).body.error.code).toBe('INVALID_STATE');
    expect(h.parse.calls.filter((c) => c.method === 'PUT' && c.body && 'ExpiryDate' in c.body)).toHaveLength(0);
  });

  it("expiry: another firm's workflow is not found, a mismatched firm is refused, an unknown workflow is not found", async () => {
    await createWorkflow(h);
    await h.opensignService!.initFirm({ scenticFirmId: FIRM2, firmName: 'Beta Law' }, 'corr');
    expect((await expiry(h, inDays(5), WF, FIRM2)).status).toBe(404);
    const mismatch = await expiry(h, inDays(5), WF, FIRM1, FIRM2);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('FIRM_SCOPE_VIOLATION');
    expect((await expiry(h, inDays(5), 'nope')).status).toBe(404);
    expect(h.parse.calls.filter((c) => c.method === 'PUT' && c.body && 'ExpiryDate' in c.body)).toHaveLength(0);
    expect(SIGNATURE_CAPABILITIES.changeExpiry).toBe('supported');
  });
});

// Two gateway instances are two stores on one database. Requires CONTRACT_POSTGRES_URL, as above.
describe.skipIf(!POSTGRES_URL)('the workflow lock across instances (PostgreSQL; requires CONTRACT_POSTGRES_URL)', () => {
  const stores: Array<{ close: () => Promise<void> }> = [];
  const open = async () => {
    const { PostgresMappingStore } = await import('../storage/postgres-store.js');
    const store = new PostgresMappingStore(POSTGRES_URL!, 'disable');
    stores.push(store);
    return store;
  };
  afterEach(async () => { while (stores.length) await stores.pop()!.close(); });
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('two calls for one workflow through two instances run one after the other; another workflow does not wait', async () => {
    const [a, b] = [await open(), await open()];
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => { order.push(`${name}:in`); await pause(ms); order.push(`${name}:out`); return name; };
    const first = a.withWorkflowLock('firm:wf-lock', task('a', 400));
    await pause(100);
    const results = await Promise.all([first, b.withWorkflowLock('firm:wf-lock', task('b', 10)), b.withWorkflowLock('firm:wf-other', task('c', 10))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(order.indexOf('a:out')).toBeLessThan(order.indexOf('b:in'));
    expect(order.indexOf('c:out')).toBeLessThan(order.indexOf('a:out'));
  });

  it('a holder that throws releases the lock, and its error is the one thrown', async () => {
    const [a, b] = [await open(), await open()];
    await expect(a.withWorkflowLock('firm:wf-throw', async () => { throw new Error('holder failed'); })).rejects.toThrow('holder failed');
    const started = Date.now();
    await expect(b.withWorkflowLock('firm:wf-throw', async () => 'free', { waitMs: 2000 })).resolves.toBe('free');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a lock not free within the wait is WorkflowLockBusy; the task did not run; the holder is undisturbed', async () => {
    const [a, b] = [await open(), await open()];
    let ran = false;
    const holder = a.withWorkflowLock('firm:wf-busy', async () => { await pause(1200); return 'held'; });
    await pause(100);
    const started = Date.now();
    await expect(b.withWorkflowLock('firm:wf-busy', async () => { ran = true; }, { waitMs: 400 })).rejects.toBeInstanceOf(WorkflowLockBusy);
    expect(ran).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(holder).resolves.toBe('held');
    await expect(b.withWorkflowLock('firm:wf-busy', async () => 'after', { waitMs: 400 })).resolves.toBe('after');
  });

  it("a holder whose connection is lost holds nothing: the lock goes with it, at once, and the process carries on", async () => {
    const [a, b] = [await open(), await open()];
    const pg = await import('pg');
    const raw = new pg.default.Pool({ connectionString: POSTGRES_URL });
    try {
      let finished = false;
      const holder = a.withWorkflowLock('firm:wf-crash', async () => { await pause(1500); finished = true; return 'done'; });
      await pause(150);
      // What a crashed instance looks like from the database: its session ends.
      const killed = await raw.query("SELECT pg_terminate_backend(pid) AS ok FROM pg_locks WHERE locktype = 'advisory' AND granted");
      expect(killed.rows).toHaveLength(1);
      const started = Date.now();
      await expect(b.withWorkflowLock('firm:wf-crash', async () => 'taken', { waitMs: 3000 })).resolves.toBe('taken');
      expect(Date.now() - started).toBeLessThan(800);
      expect(finished).toBe(false);
      // The holder's own task is not interrupted, and its broken connection is thrown away, not reused.
      await expect(holder).resolves.toBe('done');
      await expect(a.withWorkflowLock('firm:wf-crash', async () => 'again', { waitMs: 3000 })).resolves.toBe('again');
    } finally { await raw.end(); }
  });

  it('after many uses no lock is left behind in the database', async () => {
    const a = await open();
    await Promise.all(Array.from({ length: 20 }, (_, i) => a.withWorkflowLock(`firm:wf-many-${i % 4}`, async () => i)));
    const pg = await import('pg');
    const raw = new pg.default.Pool({ connectionString: POSTGRES_URL });
    try {
      const held = await raw.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
      expect(held.rows[0].n).toBe(0);
    } finally { await raw.end(); }
  });
});

// A signature handed to OpenSign and never answered, on each kind of store an instance can have.
const DOUBT_STORES: Array<[string, () => Promise<{ store: MappingStore; close: () => Promise<void> }>]> = [
  ['memory', async () => ({ store: new InMemoryMappingStore(), close: async () => undefined })],
  ['SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-doubt-'));
    const store = new SqliteMappingStore(join(dir, 'd.db'));
    return { store, close: async () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
  }],
  ...(process.env.CONTRACT_POSTGRES_URL
    ? [['PostgreSQL', async () => {
        const { PostgresMappingStore } = await import('../storage/postgres-store.js');
        const store = new PostgresMappingStore(process.env.CONTRACT_POSTGRES_URL!, 'disable');
        await store.initSchema();
        return { store: store as unknown as MappingStore, close: () => store.close() };
      }] as [string, () => Promise<{ store: MappingStore; close: () => Promise<void> }>]]
    : []),
];
describe.each(DOUBT_STORES)('a signature OpenSign never answered for (%s store)', (_name, open) => {
  let h: Harness;
  let opened: { store: MappingStore; close: () => Promise<void> };
  let firm: string;
  const sign = (email: string, stamped: Buffer, base: Buffer) => ceremony(h, 'sign', signBody(email, stamped, base), firm);
  const mark = async () => (await opened.store.getOpenSignWorkflowMapping(firm, WF))!;

  beforeEach(async () => {
    opened = await open();
    // A firm of its own each time: the PostgreSQL database is shared between runs.
    firm = `firm-${Math.random().toString(36).slice(2, 10)}`;
    h = harness({ signMs: 60 }, opened.store);
    await createWorkflow(h, { ceremony: 'scentic' }, firm);
    h.parse.hang = 'signPdf';
    const unanswered = await sign(ALICE, pdf('alice'), ORIGINAL);
    expect(unanswered.status).toBe(502);
    expect(unanswered.body.error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    h.parse.hang = null;
  });
  afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await opened.close(); });

  it('is marked on the workflow for four minutes, with the PDF as it stood', async () => {
    const m = await mark();
    expect(m.signInDoubtSha).toBe(sha(ORIGINAL));
    const left = new Date(m.signInDoubtUntil!).getTime() - Date.now();
    expect(left).toBeGreaterThan(SIGN_IN_DOUBT_MS - 5000);
    expect(left).toBeLessThanOrEqual(SIGN_IN_DOUBT_MS);
  });

  it('while nothing has changed, nobody signs on top of it: a retryable BUSY, for that signer and for any other', async () => {
    for (const [email, stamped] of [[ALICE, pdf('alice')], [BOB, pdf('bob')]] as const) {
      const res = await sign(email, stamped, ORIGINAL);
      expect(res.status, email).toBe(409);
      expect(res.body.error, email).toMatchObject({ code: 'BUSY', retryable: true });
    }
    // Only the unanswered submission ever reached OpenSign.
    expect(callsTo(h, 'signPdf')).toHaveLength(1);
    expect((await mark()).signInDoubtUntil).not.toBeNull();
    // Looking and declining are not held back.
    expect((await ceremony(h, 'viewed', { email: BOB, ipAddress: '' }, firm)).status).toBe(200);
  });

  it('once it has landed: that signer hears ALREADY_SIGNED, the next signer works from the new PDF, and the mark is gone', async () => {
    // OpenSign finishes what it was asked, after the gateway stopped waiting.
    const late = pdf('alice, late');
    const landed = await h.parse.fetch('http://localhost:8080/app/functions/signPdf', {
      method: 'POST',
      headers: { 'X-Parse-Application-Id': 'opensign', 'X-Parse-Master-Key': 'test-master-key' },
      body: JSON.stringify({ docId: 'os-doc-1', userId: 'contact-1', pdfFile: late.toString('base64'), signature: PNG_B64 }),
    });
    expect(landed.status).toBe(200);

    const again = await sign(ALICE, pdf('alice'), ORIGINAL);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SIGNED');
    // Bob stamped the original, which is no longer current: told so, not told to wait.
    const stale = await sign(BOB, pdf('bob on original'), ORIGINAL);
    expect(stale.body.error).toMatchObject({ code: 'STALE_DOCUMENT', retryable: true });
    expect((await mark()).signInDoubtUntil ?? null).toBeNull();
    expect((await mark()).signInDoubtSha ?? null).toBeNull();
    const done = await sign(BOB, pdf('alice+bob'), late);
    expect(done.status).toBe(200);
    expect(done.body.data.completed).toBe(true);
  });

  it('once the four minutes are up and nothing landed: signing goes ahead, and the mark is gone', async () => {
    await opened.store.setOpenSignWorkflowSignInDoubt(firm, WF, { until: new Date(Date.now() - 1000).toISOString(), sha256: sha(ORIGINAL) });
    const res = await sign(ALICE, pdf('alice'), ORIGINAL);
    expect(res.status).toBe(200);
    expect((await mark()).signInDoubtUntil ?? null).toBeNull();
    // Nothing is in doubt after an ordinary signature either.
    expect((await sign(BOB, pdf('alice+bob'), pdf('alice'))).status).toBe(200);
  });

  // NEW-1. Whether a signature was taken is unknown after any failure that is not OpenSign saying
  // no: the mark is set for each of them, not only for a call that timed out.
  it.each([
    ['a dropped connection', (p: FakeParse) => { p.drop = 'signPdf'; }],
    ['a 500', (p: FakeParse) => p.failNext('signPdf', 500, { error: 'boom' })],
    ['a 502', (p: FakeParse) => p.failNext('signPdf', 502, { error: 'bad gateway' })],
    ['a 503', (p: FakeParse) => p.failNext('signPdf', 503, { error: 'unavailable' })],
    ['a 504', (p: FakeParse) => p.failNext('signPdf', 504, { error: 'gateway timeout' })],
    ['a 200 that does not say it signed', (p: FakeParse) => p.failNext('signPdf', 200, { result: { status: 'error' } })],
  ] as Array<[string, (p: FakeParse) => void]>)('%s leaves the signature in doubt for thirty seconds, not four minutes: marked, and nobody signs on top of it meanwhile', async (_what, arrange) => {
    await opened.store.setOpenSignWorkflowSignInDoubt(firm, WF, null);
    const before = callsTo(h, 'signPdf').length;
    arrange(h.parse);
    const failed = await sign(ALICE, pdf('alice'), ORIGINAL);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: true });
    const m = await mark();
    expect(m.signInDoubtSha).toBe(sha(ORIGINAL));
    // The short window: most of these never reached OpenSign (a service waking from zero answers 503).
    expect(SIGN_IN_DOUBT_SHORT_MS).toBe(30_000);
    const left = new Date(m.signInDoubtUntil!).getTime() - Date.now();
    expect(left).toBeGreaterThan(SIGN_IN_DOUBT_SHORT_MS - 5000);
    expect(left).toBeLessThanOrEqual(SIGN_IN_DOUBT_SHORT_MS);
    for (const email of [ALICE, BOB]) {
      const res = await sign(email, pdf(email), ORIGINAL);
      expect(res.status, email).toBe(409);
      expect(res.body.error, email).toMatchObject({ code: 'BUSY', retryable: true });
    }
    expect(callsTo(h, 'signPdf')).toHaveLength(before + 1);
  });

  it('the short window too ends as soon as the document shows what happened, or when its thirty seconds are up', async () => {
    await opened.store.setOpenSignWorkflowSignInDoubt(firm, WF, null);
    h.parse.failNext('signPdf', 503, { error: 'unavailable' });
    expect((await sign(ALICE, pdf('alice'), ORIGINAL)).status).toBe(502);
    expect((await sign(BOB, pdf('bob'), ORIGINAL)).body.error.code).toBe('BUSY');

    // It had arrived after all: the signature lands while the mark still stands.
    const late = pdf('alice, late');
    const landed = await h.parse.fetch('http://localhost:8080/app/functions/signPdf', {
      method: 'POST',
      headers: { 'X-Parse-Application-Id': 'opensign', 'X-Parse-Master-Key': 'test-master-key' },
      body: JSON.stringify({ docId: 'os-doc-1', userId: 'contact-1', pdfFile: late.toString('base64'), signature: PNG_B64 }),
    });
    expect(landed.status).toBe(200);
    expect(new Date((await mark()).signInDoubtUntil!).getTime()).toBeGreaterThan(Date.now());
    // Read back first: the signer it was for hears they have signed; nobody is told to wait.
    const again = await sign(ALICE, pdf('alice'), ORIGINAL);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_SIGNED');
    // The PDF has changed: the mark is cleared and the next signer goes ahead on the new one.
    const done = await sign(BOB, pdf('alice+bob'), late);
    expect(done.status).toBe(200);
    expect(done.body.data.completed).toBe(true);
    expect((await mark()).signInDoubtUntil ?? null).toBeNull();
  });

  it('thirty seconds after a 503 that never arrived, with nothing changed, the same signer signs', async () => {
    await opened.store.setOpenSignWorkflowSignInDoubt(firm, WF, null);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      h.parse.failNext('signPdf', 503, { error: 'unavailable' });
      expect((await sign(ALICE, pdf('alice'), ORIGINAL)).status).toBe(502);
      vi.setSystemTime(Date.now() + SIGN_IN_DOUBT_SHORT_MS - 2000);
      expect((await sign(ALICE, pdf('alice'), ORIGINAL)).body.error.code).toBe('BUSY');
      vi.setSystemTime(Date.now() + 3000);
      expect((await sign(ALICE, pdf('alice'), ORIGINAL)).status).toBe(200);
      expect((await mark()).signInDoubtUntil ?? null).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('a timeout still holds for four minutes: thirty seconds later nobody signs on top of it', async () => {
    // beforeEach left a timed-out signature in doubt.
    const until = new Date((await mark()).signInDoubtUntil!).getTime();
    expect(until - Date.now()).toBeGreaterThan(SIGN_IN_DOUBT_MS - 5000);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + SIGN_IN_DOUBT_SHORT_MS + 5000);
      expect((await sign(ALICE, pdf('alice'), ORIGINAL)).body.error.code).toBe('BUSY');
      vi.setSystemTime(until + 1000);
      expect((await sign(ALICE, pdf('alice'), ORIGINAL)).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ['refused for this signer (403, Parse 119)', 403, { code: 119, error: 'forbidden' }, 403, 'FORBIDDEN'],
    ['refused for this signer (400, Parse 119)', 400, { code: 119, error: 'forbidden' }, 403, 'FORBIDDEN'],
    ['document not found (404, Parse 101)', 404, { code: 101, error: 'Document not found.' }, 409, 'INVALID_STATE'],
    ['document not found (400, Parse 101)', 400, { code: 101, error: 'Document not found.' }, 409, 'INVALID_STATE'],
    ['any other 4xx (400, Parse 141)', 400, { code: 141, error: 'no' }, 502, 'UPSTREAM_ERROR'],
    ['a 401', 401, { error: 'unauthorized' }, 502, 'UPSTREAM_ERROR'],
    ['a 499', 499, {}, 502, 'UPSTREAM_ERROR'],
  ] as Array<[string, number, Record<string, unknown>, number, string]>)('a definite refusal leaves no mark: %s', async (_what, upstream, body, status, code) => {
    await opened.store.setOpenSignWorkflowSignInDoubt(firm, WF, null);
    h.parse.failNext('signPdf', upstream, body);
    const refused = await sign(ALICE, pdf('alice'), ORIGINAL);
    expect(refused.status).toBe(status);
    expect(refused.body.error.code).toBe(code);
    expect((await mark()).signInDoubtUntil ?? null).toBeNull();
    expect((await mark()).signInDoubtSha ?? null).toBeNull();
    // Nothing is held back afterwards.
    expect((await sign(ALICE, pdf('alice'), ORIGINAL)).status).toBe(200);
  });
});

describe('ceremony checks (pure)', () => {
  it('a PDF over the limit is refused before it is decoded', () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]).toString('base64');
    expect(checkPdfBase64(big, 1024)).toMatchObject({ ok: false, field: 'pdfBase64', issue: 'too large' });
    expect(checkPdfBase64(big, 4096).ok).toBe(true);
  });

  it('the PDF limit follows the body limit', () => {
    expect(maxPdfBytesFromJsonLimit('64mb')).toBe(Math.floor((64 - 3) * 1024 * 1024 * 0.75));
    expect(maxPdfBytesFromJsonLimit('1gb')).toBeGreaterThan(700 * 1024 * 1024);
    expect(maxPdfBytesFromJsonLimit('nonsense')).toBe(45 * 1024 * 1024);
    expect(maxPdfBytesFromJsonLimit(undefined)).toBe(45 * 1024 * 1024);
  });

  it('IP addresses: v4, v6, empty; nothing else', () => {
    expect(checkIpAddress('203.0.113.7')).toEqual({ ok: true, value: '203.0.113.7' });
    expect(checkIpAddress(' ::1 ')).toEqual({ ok: true, value: '::1' });
    expect(checkIpAddress('')).toEqual({ ok: true, value: '' });
    expect(checkIpAddress(undefined)).toEqual({ ok: true, value: '' });
    for (const bad of ['1.2.3', 'a.b.c.d', '1.2.3.4, 5.6.7.8', '[::1]', 'unknown']) expect(checkIpAddress(bad).ok, bad).toBe(false);
  });

  it('signature: PNG magic, under a megabyte', () => {
    expect(checkSignaturePng(PNG_B64)).toEqual({ ok: true, value: PNG_B64 });
    expect(checkSignaturePng(Buffer.from('GIF89a').toString('base64')).ok).toBe(false);
    expect(checkSignaturePng('').ok).toBe(false);
  });

  it('plain text: no markup, no control or direction characters, capped', () => {
    const rlo = String.fromCodePoint(0x202e);
    const nul = String.fromCodePoint(0);
    expect(plainText(`a<b>b</b>${nul}c\r\nd ${rlo}e`, 300)).toBe('a b c d e');
    expect(plainText('x'.repeat(10), 4)).toBe('xxxx');
    expect(plainText('line one\nline two', 300, true)).toBe('line one\nline two');
    expect(checkDeclineReason('  ok  ')).toEqual({ ok: true, value: 'ok' });
  });

  it('related documents: nothing given is nothing written; an empty list is an empty list', () => {
    expect(checkRelatedDocuments(undefined)).toEqual({ ok: true, value: null });
    expect(checkRelatedDocuments(null, 2)).toEqual({ ok: true, value: null });
    expect(checkRelatedDocuments([], 1)).toEqual({ ok: true, value: [] });
    expect(checkDocumentPosition(undefined)).toEqual({ ok: true, value: null });
    expect(checkDocumentPosition(3)).toEqual({ ok: true, value: 3 });
    // A title of exactly 300 characters is taken, counted in characters and not in UTF-16 units.
    const title = '\u{1F4C4}'.repeat(300);
    expect(checkRelatedDocuments([{ position: 1, total: 1, title }])).toEqual({ ok: true, value: [{ position: 1, total: 1, title }] });
    // Direction overrides cannot be smuggled into a title.
    const rlo = String.fromCodePoint(0x202e);
    expect(checkRelatedDocuments([{ position: 1, total: 1, title: `${rlo}fdp.exe` }])).toEqual({ ok: true, value: [{ position: 1, total: 1, title: 'fdp.exe' }] });
  });

  it('audit events: nothing given is nothing written', () => {
    expect(checkAuditEvents(undefined)).toEqual({ ok: true, value: null });
    expect(checkAuditEvents([])).toEqual({ ok: true, value: [] });
  });

  it('the lock runs one task per key at a time, in order, and other keys do not wait', async () => {
    const lock = new KeyedMutex();
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([lock.run('a', task('a1', 30)), lock.run('a', task('a2', 1)), lock.run('b', task('b1', 5))]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    expect(order.indexOf('a1:end')).toBeLessThan(order.indexOf('a2:start'));
    expect(order.indexOf('b1:end')).toBeLessThan(order.indexOf('a1:end'));
    // A task that throws releases the lock.
    await expect(lock.run('a', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(lock.run('a', async () => 'after')).resolves.toBe('after');
  });

  it('who declined: resolved through the signer contact, never guessed', () => {
    const doc = {
      IsDeclined: true,
      DeclineBy: { objectId: 'u2' },
      Placeholders: [
        { Role: 'signer', email: 'a@x.com', signerObjId: 'c1' },
        { Role: 'signer', email: 'b@x.com', signerObjId: 'c2' },
      ],
      Signers: [
        { objectId: 'c1', __type: 'Object', className: 'contracts_Contactbook', Email: 'a@x.com', UserId: { objectId: 'u1' } },
        { objectId: 'c2', __type: 'Object', className: 'contracts_Contactbook', Email: 'b@x.com', UserId: { objectId: 'u2' } },
      ],
      AuditTrail: [],
    };
    expect(declinedByEmail(doc)).toBe('b@x.com');
    expect(signerRows(doc).map((r) => r.state)).toEqual(['pending', 'declined']);
    expect(declinedByEmail({ ...doc, IsDeclined: false })).toBe('');
    // The sender's own cancellation by decline, or an account nobody on the document has.
    expect(declinedByEmail({ ...doc, DeclineBy: { objectId: 'admin' } })).toBe('');
    expect(declinedByEmail({ ...doc, DeclineBy: undefined })).toBe('');
    expect(signerRows({ ...doc, DeclineBy: { objectId: 'admin' } }).map((r) => r.state)).toEqual(['pending', 'pending']);
  });
});
