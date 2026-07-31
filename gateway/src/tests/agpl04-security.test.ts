/**
 * AGPL-04 — security tests (AA–AF).
 *
 * Verifies security-critical properties of the durable SQLite storage layer:
 * signer emails are hashed (never raw), production store validation is
 * enforced, config exposes the new storage fields, the status endpoint
 * reports the real store type, and the schema stores no unexpected secrets.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

import { SqliteMappingStore } from '../storage/sqlite-store.js';
import {
  createStoreBundle,
  type StoreFactoryConfig,
} from '../storage/store-factory.js';
import { loadConfig } from '../config.js';
import { createApp } from '../app.js';
import { KimaiService } from '../kimai/kimai-service.js';
import { makeMockKimaiClient, makeTestConfig } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'storage', 'schema.sql');

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gateway-sec-test-'));
  dbPath = join(tempDir, 'sec.db');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AGPL-04 security — tests AA–AF', () => {

  // AA. SQLite store does not store raw signer emails (only hashes)
  it('AA: SQLite store does not store raw signer emails (only hashes)', async () => {
    const store = new SqliteMappingStore(dbPath);
    try {
      const rawEmail = 'signer-aa@example.com';
      const emailHash = 'sha256:' + 'a'.repeat(64); // deterministic hash fixture
      await store.upsertOpenSignSignerMapping(
        'firm-aa', 'sw-aa', 'signer-aa',
        'os-signer-aa', emailHash,
      );

      // Query the raw row directly from the DB to inspect stored columns
      const row = (store as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => Record<string, unknown> } } })
        .db.prepare('SELECT * FROM opensign_signer_mappings WHERE scentic_firm_id = ?').get('firm-aa');

      expect(row).toBeDefined();
      // The only email-like column is signer_email_hash and it holds the hash
      expect(row['signer_email_hash']).toBe(emailHash);
      expect(String(row['signer_email_hash'])).not.toContain(rawEmail);
      // No column value in the row contains the raw email
      for (const value of Object.values(row)) {
        expect(String(value)).not.toContain(rawEmail);
      }
    } finally {
      store.close();
    }
  });

  // AB. Store factory production validation rejects memory store
  it('AB: Store factory production validation rejects memory store', async () => {
    const cfg: StoreFactoryConfig = {
      storeType: 'memory',
      isProduction: true,
      allowSqliteInProduction: false,
    };
    await expect(createStoreBundle(cfg)).rejects.toThrow(/memory.*not allowed in production/i);
  });

  // AC. Store factory production validation rejects sqlite without explicit allow flag
  it('AC: Store factory production validation rejects sqlite without explicit allow flag', async () => {
    const cfg: StoreFactoryConfig = {
      storeType: 'sqlite',
      sqlitePath: dbPath,
      isProduction: true,
      allowSqliteInProduction: false,
    };
    await expect(createStoreBundle(cfg)).rejects.toThrow(/sqlite.*not allowed in production/i);
  });

  // AD. Config includes storeType, sqlitePath, allowSqliteInProduction, redisUrl fields
  it('AD: Config includes storeType, sqlitePath, allowSqliteInProduction, redisUrl fields', () => {
    const cfg = loadConfig({
      NODE_ENV: 'development',
      GATEWAY_STORE_TYPE: 'sqlite',
      GATEWAY_SQLITE_PATH: '/tmp/gateway-state.db',
      GATEWAY_ALLOW_SQLITE_IN_PRODUCTION: 'true',
      GATEWAY_REDIS_URL: 'redis://localhost:6379',
    });

    expect(cfg.storeType).toBe('sqlite');
    expect(cfg.sqlitePath).toBe('/tmp/gateway-state.db');
    expect(cfg.allowSqliteInProduction).toBe(true);
    expect(cfg.redisUrl).toBe('redis://localhost:6379');

    // Defaults when env absent
    const defaults = loadConfig({});
    expect(typeof defaults.storeType).toBe('string');
    expect(defaults.storeType).toBe('memory');
    expect(typeof defaults.sqlitePath).toBe('string');
    expect(defaults.allowSqliteInProduction).toBe(false);
    expect(defaults.redisUrl).toBeNull();
  });

  // AE. Status endpoint reports actual store type when using SQLite
  it('AE: Status endpoint reports actual store type when using SQLite', async () => {
    const store = new SqliteMappingStore(dbPath);
    try {
      const config = makeTestConfig();
      const client = makeMockKimaiClient();
      const kimaiService = new KimaiService(client, store, store, {
        useConfidentialLabels: config.useConfidentialLabels,
        defaultActivityName: config.defaultActivityName,
        adminUsername: config.kimaiAdminUsername,
        adminApiToken: config.kimaiAdminApiToken,
      });

      const app = createApp({
        config,
        kimaiService,
        mappingStore: store,
        nonceStore: store,
        upstreamSources: {
          kimaiSha: '7c2ed4b07cca2e15b1ab4cc5947afdf899a76401',
          opensignSha: 'f72624fa26211fe00776453d99a67120a4f5e060',
        },
        storeType: 'sqlite',
        nonceStoreType: 'sqlite',
        outboxStoreType: 'sqlite',
      });

      const res = await request(app).get('/api/v1/status');
      expect(res.status).toBe(200);
      expect(res.body.data.stores.mapping).toBe('sqlite');
      expect(res.body.data.stores.nonce).toBe('sqlite');
      expect(res.body.data.stores.outbox).toBe('sqlite');

      // SQLite must not surface the in-memory warnings
      const warnings: string[] = res.body.data.warnings;
      expect(warnings.some(w => /In-memory mapping store/.test(w))).toBe(false);
    } finally {
      store.close();
    }
  });

  // AF. No secrets stored in SQLite tables (schema has no token/secret columns except expected)
  it('AF: No secrets stored in SQLite tables (schema has no token/secret columns except kimai_api_token which is expected)', () => {
    const schema = readFileSync(schemaPath, 'utf-8');

    // Extract column definitions: lines like `  column_name TYPE ...`
    const columnRegex = /^\s{2,}(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/gim;
    const columns: Array<{ table: string; column: string }> = [];
    let currentTable = '';
    for (const line of schema.split('\n')) {
      const tableMatch = line.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (tableMatch) { currentTable = tableMatch[1]; continue; }
      const colMatch = line.match(/^\s{2,}(\w+)\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/i);
      if (colMatch && currentTable) {
        columns.push({ table: currentTable, column: colMatch[1] });
      }
    }

    expect(columns.length).toBeGreaterThan(0);

    // Sensitive column-name patterns
    const sensitivePattern = /token|secret|password|private_?key|api_?key|credential/i;
    const sensitive = columns.filter(c => sensitivePattern.test(c.column));

    // The only allowed token-bearing columns are kimai_api_token (Kimai API token,
    // encrypted at rest in production per types.ts) and opensign_session_token
    // (OpenSign session token, encrypted at rest in production). No raw signer
    // emails, no HMAC secrets, no webhook secrets, no master keys, no passwords.
    const allowed = new Set(['kimai_api_token', 'opensign_session_token']);
    const unexpected = sensitive.filter(c => !allowed.has(c.column));

    expect(unexpected).toEqual([]);

    // Explicitly assert the signer table stores only a hash, never a raw email
    const signerCols = columns.filter(c => c.table === 'opensign_signer_mappings').map(c => c.column);
    expect(signerCols).toContain('signer_email_hash');
    expect(signerCols.some(c => /email$/i.test(c) && !/hash/.test(c))).toBe(false);
  });
});
