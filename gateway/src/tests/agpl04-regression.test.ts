/**
 * AGPL-04 — regression tests (AG–AK).
 *
 * Ensures the AGPL-04 durable-storage changes do not regress prior behavior:
 * the in-memory store path still works, app accepts an injected nonceStore,
 * the server wires the store bundle from env, the env parser is correct, and
 * the Dockerfile builds native modules.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeApp, signedRequest, makeTestConfig, type TestApp, makeMockKimaiClient } from './helpers.js';
import { createApp } from '../app.js';
import { InMemoryMappingStore } from '../mappings/mapping-store.js';
import { InMemoryEventOutbox } from '../events/outbox.js';
import { InMemoryNonceStore, type NonceStore } from '../auth/hmac.js';
import { KimaiService } from '../kimai/kimai-service.js';
import { createStoreConfigFromEnv } from '../storage/store-factory.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const gatewaySrc = path.join(repoRoot, 'gateway', 'src');
const dockerfile = path.join(repoRoot, 'deploy', 'Dockerfile.gateway');

class RecordingNonceStore implements NonceStore {
  calls: Array<{ nonce: string; timestamp: number }> = [];
  seen(nonce: string, timestamp: number): boolean {
    this.calls.push({ nonce, timestamp });
    return false;
  }
  clear(): void { this.calls = []; }
}

describe('AGPL-04 regression — tests AG–AK', () => {

  let t: TestApp;
  beforeEach(() => {
    t = makeApp({ enableOpenSign: true });
  });

  // AG. Existing memory store tests still pass (smoke across AGPL-01/02/03)
  it('AG: signed GET /api/v1/providers/kimai/health returns 200 with in-memory store (AGPL-01/02/03 smoke)', async () => {
    await t.service.initFirm({ scenticFirmId: 'firm-ag', firmName: 'Acme Law' }, 'corr-ag');

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: '/api/v1/providers/kimai/health',
      firmId: 'firm-ag',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // AH. App accepts nonceStore from deps and uses it
  it('AH: App accepts nonceStore from deps and uses it', async () => {
    const config = makeTestConfig();
    const store = new InMemoryMappingStore();
    const outbox = new InMemoryEventOutbox();
    const recording = new RecordingNonceStore();
    const kimaiService = new KimaiService(
      makeMockKimaiClient() as any,
      store, outbox,
      {
        useConfidentialLabels: config.useConfidentialLabels,
        defaultActivityName: config.defaultActivityName,
        adminUsername: config.kimaiAdminUsername,
        adminApiToken: config.kimaiAdminApiToken,
      },
    );

    const app = createApp({
      config,
      kimaiService,
      mappingStore: store,
      nonceStore: recording,
      upstreamSources: {
        kimaiSha: '7c2ed4b07cca2e15b1ab4cc5947afdf899a76401',
        opensignSha: 'f72624fa26211fe00776453d99a67120a4f5e060',
      },
    });

    // Seed firm so the health route has state
    await kimaiService.initFirm({ scenticFirmId: 'firm-ah', firmName: 'Firm AH' }, 'corr-ah');

    const nonce = 'nonce-ah-' + crypto.randomUUID();
    const res = await signedRequest(app, {
      method: 'GET',
      path: '/api/v1/providers/kimai/health',
      firmId: 'firm-ah',
      nonce,
    });

    expect(res.status).toBe(200);
    // The injected nonceStore must have been consulted with the request nonce
    expect(recording.calls.length).toBeGreaterThanOrEqual(1);
    expect(recording.calls.some(c => c.nonce === nonce)).toBe(true);
  });

  // AI. Server creates store bundle from env config (static source check)
  it('AI: Server creates store bundle from env config', () => {
    const serverFile = path.join(gatewaySrc, 'server.ts');
    expect(existsSync(serverFile)).toBe(true);
    const src = readFileSync(serverFile, 'utf-8');

    // server.ts must import and use the factory
    expect(src).toMatch(/import.*createStoreBundle.*from.*storage\/store-factory/);
    expect(src).toMatch(/createStoreConfigFromEnv/);
    expect(src).toMatch(/createStoreBundle\(/);
    // The bundle's stores must be wired into createApp
    expect(src).toMatch(/mappingStore/);
    expect(src).toMatch(/nonceStore/);
    expect(src).toMatch(/storeType:\s*storeBundle\.storeType/);
    // Graceful close of the store bundle on shutdown
    expect(src).toMatch(/storeBundle\.close/);
  });

  // AJ. Store factory createStoreConfigFromEnv parses env correctly
  it('AJ: Store factory createStoreConfigFromEnv parses env correctly', () => {
    // Production + sqlite + allow flag + redis
    const prod = createStoreConfigFromEnv({
      NODE_ENV: 'production',
      GATEWAY_STORE_TYPE: 'sqlite',
      GATEWAY_SQLITE_PATH: '/data/gw.db',
      GATEWAY_ALLOW_SQLITE_IN_PRODUCTION: 'true',
      GATEWAY_REDIS_URL: 'redis://redis:6379',
    });
    expect(prod.isProduction).toBe(true);
    expect(prod.storeType).toBe('sqlite');
    expect(prod.sqlitePath).toBe('/data/gw.db');
    expect(prod.allowSqliteInProduction).toBe(true);
    expect(prod.redisUrl).toBe('redis://redis:6379');

    // Defaults when env absent
    const defaults = createStoreConfigFromEnv({});
    expect(defaults.isProduction).toBe(false);
    expect(defaults.storeType).toBe('memory');
    expect(defaults.allowSqliteInProduction).toBe(false);
    expect(defaults.sqlitePath).toBeUndefined();
    expect(defaults.redisUrl).toBeUndefined();

    // Staging is not production
    const staging = createStoreConfigFromEnv({ NODE_ENV: 'staging', GATEWAY_STORE_TYPE: 'memory' });
    expect(staging.isProduction).toBe(false);
    expect(staging.storeType).toBe('memory');
  });

  // AK. Dockerfile.gateway includes build tools for native modules
  it('AK: Dockerfile.gateway includes build tools for native modules', () => {
    expect(existsSync(dockerfile)).toBe(true);
    const df = readFileSync(dockerfile, 'utf-8');

    // better-sqlite3 requires python3, make, and g++ to compile native bits
    expect(df).toMatch(/python3/);
    expect(df).toMatch(/\bmake\b/);
    expect(df).toMatch(/g\+\+/);
    // Schema asset must be copied into dist so the compiled server can read it
    expect(df).toMatch(/schema\.sql/);
    expect(df).toMatch(/node:20/);
  });
});
