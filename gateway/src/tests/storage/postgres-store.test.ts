/**
 * AGPL-05 — Postgres store tests (A–L).
 *
 * Tests A-K are env-gated (require running Postgres at GATEWAY_PG_TEST_URL).
 * Test L is a static config check.
 *
 * Env: GATEWAY_PG_TEST_URL=postgres://gateway:dev-gateway-pg-pass@localhost:5433/gateway
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const shouldRun = !!process.env.GATEWAY_PG_TEST_URL;
const describeOrSkip = shouldRun ? describe : describe.skip;

const pgUrl = process.env.GATEWAY_PG_TEST_URL || '';

describeOrSkip('AGPL-05 Postgres store CRUD — tests A–K (requires GATEWAY_PG_TEST_URL)', () => {
  let PostgresMappingStore: any;
  let store: any;

  beforeEach(async () => {
    const mod = await import('../../storage/postgres-store.js');
    PostgresMappingStore = mod.PostgresMappingStore;
    store = new PostgresMappingStore(pgUrl, 'disable');
    await store.initSchema();
  });

  afterEach(async () => {
    if (store) {
      await store.clear();
      await store.close();
    }
  });

  // A. Postgres schema validates (initSchema runs without error)
  it('A: Postgres schema validates', async () => {
    // If we got here, initSchema() succeeded in beforeEach
    expect(store).toBeDefined();
  });

  // B. Postgres mappings persist across store recreation
  it('B: Postgres mappings persist across store recreation', async () => {
    const firmId = `pg-test-${crypto.randomUUID()}`;
    await store.upsertFirmMapping(
      { scenticFirmId: firmId, firmName: 'Test Firm' },
      999, 'Test Team'
    );
    await store.close();

    const store2 = new PostgresMappingStore(pgUrl, 'disable');
    const retrieved = await store2.getFirmMapping(firmId);
    expect(retrieved).not.toBeNull();
    expect(retrieved.kimaiTeamId).toBe(999);
    await store2.clear();
    await store2.close();
  });

  // C. Postgres nonces prevent replay across store recreation
  it('C: Postgres nonces prevent replay across store recreation', async () => {
    const nonce = `pg-nonce-${crypto.randomUUID()}`;
    const ts = Date.now();
    const seen1 = await store.seen(nonce, ts);
    expect(seen1).toBe(false);

    await store.close();
    const store2 = new PostgresMappingStore(pgUrl, 'disable');
    const seen2 = await store2.seen(nonce, ts);
    expect(seen2).toBe(true);
    await store2.clear();
    await store2.close();
  });

  // D. Postgres idempotency prevents duplicate writes (via unique constraints)
  it('D: Postgres unique constraints prevent duplicate mappings', async () => {
    const firmId = `pg-dup-${crypto.randomUUID()}`;
    const m1 = await store.upsertFirmMapping(
      { scenticFirmId: firmId, firmName: 'Firm 1' },
      100, 'Team 1'
    );
    const m2 = await store.upsertFirmMapping(
      { scenticFirmId: firmId, firmName: 'Firm 2' },
      200, 'Team 2'
    );
    // Upsert should update, not duplicate
    expect(m1.id).toBe(m2.id);
    expect(m2.kimaiTeamId).toBe(200);
  });

  // E. Postgres outbox events survive restart
  it('E: Postgres outbox events survive restart', async () => {
    await store.publish({
      eventType: 'KIMAI_FIRM_INITIALIZED',
      scenticFirmId: 'pg-outbox-test',
      correlationId: 'corr-1',
      payload: { test: true },
      safeSummary: 'Test event',
    });
    await store.close();

    const store2 = new PostgresMappingStore(pgUrl, 'disable');
    const pending = await store2.getPending();
    expect(pending.length).toBeGreaterThan(0);
    const found = pending.find(e => e.scenticFirmId === 'pg-outbox-test');
    expect(found).toBeDefined();
    await store2.clear();
    await store2.close();
  });

  // F. Postgres retry state persists
  it('F: Postgres retry state persists', async () => {
    const event = await store.publish({
      eventType: 'KIMAI_SYNC_FAILED',
      scenticFirmId: 'pg-retry-test',
      correlationId: 'corr-2',
      payload: { error: 'test' },
      safeSummary: 'Retry test',
    });
    await store.markFailed(event.eventId);
    const all = await store.getAll();
    const updated = all.find(e => e.eventId === event.eventId);
    expect(updated.retryCount).toBe(1);
  });

  // G. Postgres duplicate completion event prevented (unique constraints)
  it('G: Postgres upsert prevents duplicate completion events', async () => {
    const firmId = `pg-comp-${crypto.randomUUID()}`;
    const m1 = await store.upsertFirmMapping(
      { scenticFirmId: firmId, firmName: 'Firm' },
      300, 'Team'
    );
    // Second upsert with same firmId should update, not create new
    const m2 = await store.upsertFirmMapping(
      { scenticFirmId: firmId, firmName: 'Firm Updated' },
      301, 'Team Updated'
    );
    const all = await store.getFirmMapping(firmId);
    expect(all.kimaiTeamName).toBe('Team Updated');
  });

  // H. Postgres records are Firm-scoped
  it('H: Postgres records are Firm-scoped', async () => {
    await store.upsertFirmMapping(
      { scenticFirmId: 'firm-pg-h-1', firmName: 'Firm H1' },
      401, 'Team H1'
    );
    await store.upsertUserMapping(
      { scenticFirmId: 'firm-pg-h-1', scenticUserId: 'user-h-1', email: 'h1@test.com', kimaiUsername: 'h1user' },
      501, 'h1user', 'token-h1'
    );
    const user = await store.getUserMapping('firm-pg-h-1', 'user-h-1');
    expect(user).not.toBeNull();
    expect(user.kimaiUsername).toBe('h1user');
  });

  // I. Cross-Firm lookup denied
  it('I: Cross-Firm lookup denied', async () => {
    await store.upsertUserMapping(
      { scenticFirmId: 'firm-pg-i-1', scenticUserId: 'user-i', email: 'i1@test.com', kimaiUsername: 'i1user' },
      601, 'i1user', 'token-i1'
    );
    // Looking up user from firm-pg-i-1 in a different firm context should return null
    const crossFirm = await store.getUserMapping('firm-pg-i-2', 'user-i');
    expect(crossFirm).toBeNull();
  });

  // J. Production accepts Postgres store
  it('J: Production accepts Postgres store (static check)', () => {
    const factorySource = readFileSync(
      path.join(repoRoot, 'gateway', 'src', 'storage', 'store-factory.ts'),
      'utf-8'
    );
    // The factory should NOT reject postgres in production
    expect(factorySource).not.toMatch(/postgres.*not.*allowed.*production/i);
    // The factory should reject memory in production
    expect(factorySource).toMatch(/memory.*not.*allowed.*production/i);
  });

  // K. Docker config uses Postgres by default
  it('K: Docker config uses Postgres by default (static check)', () => {
    const composeSource = readFileSync(
      path.join(repoRoot, 'deploy', 'docker-compose.yml'),
      'utf-8'
    );
    expect(composeSource).toContain('GATEWAY_STORE_TYPE=postgres');
    expect(composeSource).toContain('gateway-postgres');
    expect(composeSource).toContain('GATEWAY_DATABASE_URL');
  });
});

// L. Docker config uses Postgres by default (always runs, static check)
describe('AGPL-05 Docker/local config — test L', () => {
  it('L: Docker config uses Postgres by default', () => {
    const composeSource = readFileSync(
      path.join(repoRoot, 'deploy', 'docker-compose.yml'),
      'utf-8'
    );
    expect(composeSource).toContain('GATEWAY_STORE_TYPE=postgres');
    expect(composeSource).toContain('gateway-postgres');
    expect(composeSource).toContain('postgres:16');
  });
});
