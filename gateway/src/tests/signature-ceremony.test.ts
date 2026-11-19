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
import {
  KeyedMutex,
  MAX_AUDIT_EVENTS,
  checkAuditEvents,
  checkDeclineReason,
  checkIpAddress,
  checkPdfBase64,
  checkSignaturePng,
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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PNG_B64 = PNG.toString('base64');

interface Harness extends TestApp {
  parse: FakeParse;
  logs: string[];
}

function harness(): Harness {
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
  });
  const t = makeApp({ opensignClient: client as unknown as MockOpenSignClient });
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
    expect(call!.headers['sessiontoken']).toMatch(/^r:session-signer-user-1-/);
    expect(call!.headers['x-parse-master-key']).toBeUndefined();
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
    expect(call!.headers['x-parse-session-token']).toMatch(/^r:session-signer-user-1-/);
    expect(call!.headers['x-parse-master-key']).toBeUndefined();
    // The session was asked for with the master key, for the contact's own account.
    const login = h.parse.calls.find((c) => c.path === '/loginAs')!;
    expect(login.body).toEqual({ userId: 'signer-user-1' });
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
    expect(call!.headers['x-parse-session-token']).toMatch(/^r:session-signer-user-2-/);
    expect(call!.headers['x-forwarded-for']).toBe('198.51.100.9');
    expect(call!.headers['x-parse-master-key']).toBeUndefined();

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

  it('a session token never appears in a log line, a response or an event, on success or failure', async () => {
    await createWorkflow(h);
    const responses: string[] = [];
    const keep = async (p: Promise<{ text?: string; body: unknown }>) => { const r = await p; responses.push(JSON.stringify(r.body) + (r.text ?? '')); };
    await keep(ceremony(h, 'viewed', { email: ALICE, ipAddress: '198.51.100.4' }));
    h.parse.failNext('signPdf', 500, { error: 'boom r:session-leaked-in-upstream-body' });
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
    expect(tokens.length).toBeGreaterThanOrEqual(5);
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
