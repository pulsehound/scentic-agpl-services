import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { makeApp, makeMockKimaiClient, type TestApp } from './helpers.js';
import { KimaiClient } from '../kimai/kimai-client.js';
import { notSupported, wrapUpstreamError, type GatewayError } from '../http/errors.js';

describe('Kimai client / health / error wrapping — tests N–Q', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // N. Health check handles healthy response
  it('N: checkHealth reports healthy=true with the Kimai version when status succeeds', async () => {
    const client = makeMockKimaiClient({
      getStatus: vi.fn(async () => ({ success: true, data: { version: '2.0' } })),
    });
    const app = makeApp({ client });
    const r = await app.service.checkHealth();

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.healthy).toBe(true);
      expect(r.data.version).toBe('2.0');
    }
  });

  // O. Health check handles down response safely
  it('O: checkHealth reports healthy=false without throwing when Kimai is unreachable', async () => {
    const client = makeMockKimaiClient({
      // The real client wraps fetch failures into a { success:false } result;
      // simulate that exact shape (a fetch throw / connection error).
      getStatus: vi.fn(async () => ({
        success: false,
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Kimai GET /api/status failed: connection error', retryable: true } as unknown as GatewayError,
      })),
    });
    const app = makeApp({ client });

    // Must not throw.
    const r = await app.service.checkHealth();

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.healthy).toBe(false);
      expect(r.data.version).toBeUndefined();
    }
  });

  // P. Raw Kimai errors are wrapped safely (real client with mocked fetch)
  describe('P: raw upstream error bodies are never exposed', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('does not include the raw response body in the wrapped error message', async () => {
      const rawBodyMarker = 'SECRET_RAW_BODY_42';
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ leak: rawBodyMarker }),
        text: async () => JSON.stringify({ leak: rawBodyMarker }),
      } as unknown as Response));

      const client = new KimaiClient({
        baseUrl: 'http://localhost:8001',
        apiToken: 'some-admin-token',
        username: 'admin',
      });

      const result = await client.getStatus();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.statusCode).toBe(502);
        expect(result.error.message).not.toContain(rawBodyMarker);
        // Message is a safe generic wrapper.
        expect(result.error.message).toMatch(/Kimai.*\/api\/status/);
      }
    });
  });

  // Q. Missing unsupported Kimai operation returns NOT_SUPPORTED
  it('Q: notSupported() produces a NOT_SUPPORTED GatewayError with status 501', () => {
    const err = notSupported('Operation X is not supported by this gateway');

    expect(err.code).toBe('NOT_SUPPORTED');
    expect(err.statusCode).toBe(501);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('not supported');

    const api = err.toApiError();
    expect(api.code).toBe('NOT_SUPPORTED');
    expect(api.retryable).toBe(false);
  });

  it('Q (wrapUpstreamError): never includes raw upstream error text in the message', () => {
    const rawSecret = 'UPSTREAM_SECRET_TOKEN_xyz';
    const err = wrapUpstreamError('Kimai', 'createTimesheet', new Error(`body=${rawSecret}`));

    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.statusCode).toBe(502);
    expect(err.message).not.toContain(rawSecret);
    expect(err.message).toMatch(/Kimai createTimesheet failed/);
  });
});
