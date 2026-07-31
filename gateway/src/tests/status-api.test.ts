import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';

import { makeApp, makeTestConfig, type TestApp } from './helpers.js';

describe('Status API (provider states, secret redaction, production-readiness) — tests M–O', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp({ enableWebhook: true, enableOpenSign: true });
  });

  // M. /api/v1/status reports provider states honestly
  it('M: GET /api/v1/status reports gateway, providers, webhook, stores, warnings, blockers', async () => {
    const res = await request(t.app).get('/api/v1/status');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const data = res.body.data;
    expect(data).toBeDefined();

    // gateway block
    expect(data.gateway).toBeDefined();
    expect(data.gateway.version).toBe(t.config.gatewayVersion);
    expect(data.gateway.env).toBe(t.config.env);

    // providers block (kimai + opensign)
    expect(data.providers).toBeDefined();
    expect(data.providers.kimai).toBeDefined();
    expect(typeof data.providers.kimai.configured).toBe('boolean');
    expect(typeof data.providers.kimai.healthy).toBe('boolean');
    expect(data.providers.opensign).toBeDefined();
    expect(typeof data.providers.opensign.configured).toBe('boolean');
    expect(typeof data.providers.opensign.enabled).toBe('boolean');

    // webhook block
    expect(data.webhook).toBeDefined();
    expect(typeof data.webhook.configured).toBe('boolean');

    // stores block
    expect(data.stores).toBeDefined();
    expect(data.stores.mapping).toBeDefined();
    expect(data.stores.nonce).toBeDefined();
    expect(data.stores.outbox).toBeDefined();

    // warnings + blockers arrays present
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(Array.isArray(data.blockers)).toBe(true);
    expect(data.blockers.length).toBeGreaterThan(0);
  });

  // N. /api/v1/status redacts secrets
  it('N: GET /api/v1/status response contains no raw secrets', async () => {
    const res = await request(t.app).get('/api/v1/status');
    expect(res.status).toBe(200);

    const text = res.text;
    const secrets = [
      t.config.hmacSecret,
      t.config.webhookHmacSecret,
      t.config.kimaiAdminApiToken,
      t.config.opensignMasterKey,
      t.config.opensignAdminPassword,
    ];

    for (const s of secrets) {
      expect(text).not.toContain(s);
    }

    // No literal secret field names should expose raw values
    expect(text).not.toMatch(/"hmacSecret"\s*:/);
    expect(text).not.toMatch(/"masterKey"\s*:/);
    expect(text).not.toMatch(/"apiToken"\s*:/);
    expect(text).not.toMatch(/"password"\s*:/);
  });

  // O. /api/v1/status says productionReadiness=false
  it('O: data.gateway.productionReadiness is false', async () => {
    const res = await request(t.app).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.body.data.gateway.productionReadiness).toBe(false);
  });
});
