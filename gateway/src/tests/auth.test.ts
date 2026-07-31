import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';

import { makeApp, makeSignedHeaders, makeTestConfig, signedRequest, request } from './helpers.js';
import { createScenticAuthMiddleware } from '../auth/scentic-auth.js';
import { InMemoryNonceStore } from '../auth/hmac.js';

const FIRM_A = 'firm-aaaaaaaa';
const FIRM_B = 'firm-bbbbbbbb';

describe('Auth (HMAC, replay, firm scope, secret redaction) — tests A–G', () => {
  let t: ReturnType<typeof makeApp>;

  beforeEach(() => {
    t = makeApp();
  });

  // A. Valid HMAC request accepted
  it('A: accepts a request with a valid signature and returns 200', async () => {
    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM_A}/init`,
      bodyObj: { firmName: 'Acme Law' },
      firmId: FIRM_A,
      idempotencyKey: 'idem-A',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.scenticFirmId).toBe(FIRM_A);
  });

  // B. Missing signature rejected
  it('B: rejects a request missing X-Scentic-Signature with 401', async () => {
    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM_A}/init`,
      bodyObj: { firmName: 'Acme Law' },
      firmId: FIRM_A,
      omitSignature: true,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // C. Bad signature rejected
  it('C: rejects a request with a wrong signature with 401', async () => {
    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM_A}/init`,
      bodyObj: { firmName: 'Acme Law' },
      firmId: FIRM_A,
      badSignature: true,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  // D. Stale timestamp rejected
  it('D: rejects a request whose timestamp is older than the tolerance window with 401', async () => {
    const stale = String(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM_A}/init`,
      bodyObj: { firmName: 'Acme Law' },
      firmId: FIRM_A,
      timestamp: stale,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toMatch(/stale/i);
  });

  // E. Replay nonce rejected
  it('E: rejects a replayed nonce on the second request with 401', async () => {
    const fixedNonce = 'nonce-replay-fixed';
    const ts = String(Date.now());
    const path = `/api/v1/firms/${FIRM_A}/init`;
    const bodyObj = { firmName: 'Acme Law' };

    const first = await signedRequest(t.app, {
      method: 'POST',
      path,
      bodyObj,
      firmId: FIRM_A,
      nonce: fixedNonce,
      timestamp: ts,
      idempotencyKey: 'idem-E1',
    });
    expect(first.status).toBe(200);

    const second = await signedRequest(t.app, {
      method: 'POST',
      path,
      bodyObj,
      firmId: FIRM_A,
      nonce: fixedNonce,
      timestamp: ts,
      idempotencyKey: 'idem-E2',
    });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('UNAUTHORIZED');
    expect(second.body.error.message).toMatch(/nonce/i);
  });

  // F. Path Firm ID mismatch rejected (auth middleware tested in isolation
  // so req.params.firmId is populated when the middleware runs).
  it('F: rejects a request whose path firm ID differs from the signed firm ID with 403', async () => {
    const nonceStore = new InMemoryNonceStore();
    const config = makeTestConfig();
    const app = express();
    app.use(express.json());
    app.post(
      '/api/v1/firms/:firmId/test',
      createScenticAuthMiddleware({
        hmacSecret: config.hmacSecret,
        nonceStore,
        timestampToleranceMs: 300_000,
      }),
      (_req, res) => res.json({ ok: true }),
    );
    // Error handler mirroring app.ts
    app.use((err: Error & { statusCode?: number; toApiError?: () => unknown }, _req, res, _next) => {
      if (err && typeof err.statusCode === 'number' && typeof err.toApiError === 'function') {
        res.status(err.statusCode).json({ ok: false, error: err.toApiError() });
      } else {
        res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'internal' } });
      }
    });

    const res = await signedRequest(app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM_B}/test`,
      bodyObj: {},
      firmId: FIRM_A,
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FIRM_SCOPE_VIOLATION');
  });

  // G. Secrets redacted on health endpoint
  it('G: health endpoint does not expose the HMAC secret or Kimai API token', async () => {
    const res = await request(t.app).get('/health');

    expect(res.status).toBe(200);
    const text = res.text;
    expect(text).not.toContain(t.config.hmacSecret);
    expect(text).not.toContain(t.config.kimaiAdminApiToken);
    expect(text).not.toContain(t.config.webhookHmacSecret);
  });
});
