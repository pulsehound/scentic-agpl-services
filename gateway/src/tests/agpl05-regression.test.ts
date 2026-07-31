/**
 * AGPL-05 — Regression tests (AM–AP).
 *
 * Smoke tests verifying that AGPL-01 through AGPL-04 functionality still works
 * after the async refactoring and Postgres store addition.
 */

import { describe, it, expect } from 'vitest';
import { makeApp, signedRequest, type TestApp } from './helpers.js';

describe('AGPL-05 regression — tests AM–AP', () => {
  let t: TestApp;
  beforeEach(() => {
    t = makeApp({ enableOpenSign: true });
  });

  // AM. All AGPL-01 tests still pass (Kimai health smoke)
  it('AM: signed GET /api/v1/providers/kimai/health returns 200 (AGPL-01 smoke)', async () => {
    await t.service.initFirm({ scenticFirmId: 'firm-am', firmName: 'Acme Law' }, 'corr-am');
    const res = await signedRequest(t.app, {
      method: 'GET',
      path: '/api/v1/providers/kimai/health',
      firmId: 'firm-am',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // AN. All AGPL-02 tests still pass (OpenSign health smoke)
  it('AN: signed GET /api/v1/providers/opensign/health returns 200 (AGPL-02 smoke)', async () => {
    const res = await signedRequest(t.app, {
      method: 'GET',
      path: '/api/v1/providers/opensign/health',
      firmId: 'firm-an',
    });
    expect(res.status).toBe(200);
  });

  // AO. All AGPL-03 tests still pass (status endpoint smoke)
  it('AO: GET /api/v1/status returns 200 with stores info (AGPL-03 smoke)', async () => {
    const res = await signedRequest(t.app, {
      method: 'GET',
      path: '/api/v1/status',
      firmId: 'firm-ao',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.stores).toBeDefined();
  });

  // AP. All AGPL-04 tests still pass (store factory config smoke)
  it('AP: store factory config from env parses correctly (AGPL-04 smoke)', async () => {
    const { createStoreConfigFromEnv } = await import('../storage/store-factory.js');
    const config = createStoreConfigFromEnv({
      GATEWAY_STORE_TYPE: 'postgres',
      GATEWAY_DATABASE_URL: 'postgres://test:test@localhost/test',
      GATEWAY_POSTGRES_SSL_MODE: 'disable',
      NODE_ENV: 'development',
    });
    expect(config.storeType).toBe('postgres');
    expect(config.databaseUrl).toBe('postgres://test:test@localhost/test');
  });
});
