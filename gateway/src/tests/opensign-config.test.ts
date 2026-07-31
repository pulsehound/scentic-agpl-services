import { describe, it, expect, beforeEach } from 'vitest';

import { makeApp, makeTestConfig, signedRequest, request, type TestApp } from './helpers.js';
import { loadConfig, redactSecret } from '../config.js';

const FIRM1 = 'firm-11111111';

describe('OpenSign config (disabled, production secrets, redaction) — tests C–E', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // C. Missing OpenSign config reports disabled
  it('C: when opensignEnabled=false the health endpoint reports opensignEnabled: false', async () => {
    const config = makeTestConfig({ opensignEnabled: false });
    const app = makeApp({ config, enableOpenSign: false });

    const res = await request(app.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.opensignEnabled).toBe(false);
  });

  // D. Production rejects placeholder OpenSign secrets
  it('D: loadConfig throws in production when OPENSIGN_ENABLED=true and OPENSIGN_MASTER_KEY is a placeholder', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SCENTIC_SHARED_HMAC_SECRET: 'a-very-strong-production-secret-123',
        SCENTIC_WEBHOOK_HMAC_SECRET: 'a-very-strong-webhook-secret-123',
        SCENTIC_GATEWAY_INTERNAL_BASE_URL: 'http://10.0.0.5:3101',
        SCENTIC_GATEWAY_PUBLIC_BASE_URL: 'http://10.0.0.5:3101',
        SCENTIC_WEBHOOK_TARGET_URL: 'http://10.0.0.5:9000/webhook',
        KIMAI_BASE_URL: 'http://10.0.0.5:8001',
        KIMAI_ADMIN_API_TOKEN: 'a-strong-kimai-token-123',
        OPENSIGN_ENABLED: 'true',
        OPENSIGN_BASE_URL: 'http://10.0.0.5:8080/app',
        OPENSIGN_MASTER_KEY: 'changeme',
        OPENSIGN_ADMIN_EMAIL: 'admin@opensign.prod',
        OPENSIGN_ADMIN_PASSWORD: 'a-strong-opensign-password-123',
      }),
    ).toThrow();

    // Sanity: a strong master key does NOT throw.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        SCENTIC_SHARED_HMAC_SECRET: 'a-very-strong-production-secret-123',
        SCENTIC_WEBHOOK_HMAC_SECRET: 'a-very-strong-webhook-secret-123',
        SCENTIC_GATEWAY_INTERNAL_BASE_URL: 'http://10.0.0.5:3101',
        SCENTIC_GATEWAY_PUBLIC_BASE_URL: 'http://10.0.0.5:3101',
        SCENTIC_WEBHOOK_TARGET_URL: 'http://10.0.0.5:9000/webhook',
        KIMAI_BASE_URL: 'http://10.0.0.5:8001',
        KIMAI_ADMIN_API_TOKEN: 'a-strong-kimai-token-123',
        OPENSIGN_ENABLED: 'true',
        OPENSIGN_BASE_URL: 'http://10.0.0.5:8080/app',
        OPENSIGN_MASTER_KEY: 'a-strong-opensign-master-key-abc',
        OPENSIGN_ADMIN_EMAIL: 'admin@opensign.prod',
        OPENSIGN_ADMIN_PASSWORD: 'a-strong-opensign-password-123',
      }),
    ).not.toThrow();
  });

  // E. OpenSign secrets redacted on health endpoint
  it('E: health endpoint does not expose the raw OpenSign master key', async () => {
    const res = await request(t.app).get('/health');
    expect(res.status).toBe(200);

    const text = res.text;
    expect(text).not.toContain(t.config.opensignMasterKey);
    expect(text).not.toContain(t.config.opensignAdminPassword);

    // redactSecret produces a masked form, never the raw value.
    const redacted = redactSecret(t.config.opensignMasterKey);
    expect(redacted).not.toBe(t.config.opensignMasterKey);
    expect(redacted).toContain('****');
  });
});
