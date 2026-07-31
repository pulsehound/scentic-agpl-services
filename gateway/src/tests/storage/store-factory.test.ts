/**
 * AGPL-04 — store-factory tests (L–P).
 *
 * Verifies createStoreBundle selects the correct implementation and enforces
 * production validation rules (memory and sqlite rejected in production
 * unless explicitly allowed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createStoreBundle,
  createStoreConfigFromEnv,
  type StoreFactoryConfig,
} from '../../storage/store-factory.js';
import { InMemoryMappingStore } from '../../mappings/mapping-store.js';
import { InMemoryNonceStore } from '../../auth/hmac.js';
import { InMemoryEventOutbox } from '../../events/outbox.js';
import { SqliteMappingStore } from '../../storage/sqlite-store.js';

let tempDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gateway-factory-test-'));
  dbPath = join(tempDir, 'factory.db');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function devConfig(storeType: 'memory' | 'sqlite', extra: Partial<StoreFactoryConfig> = {}): StoreFactoryConfig {
  return {
    storeType,
    sqlitePath: dbPath,
    isProduction: false,
    allowSqliteInProduction: false,
    ...extra,
  };
}

describe('AGPL-04 store-factory — tests L–P', () => {

  // L. memory bundle returns InMemory* instances
  it('L: createStoreBundle with memory returns InMemoryMappingStore instances', () => {
    const bundle = createStoreBundle(devConfig('memory'));

    expect(bundle.storeType).toBe('memory');
    expect(bundle.nonceStoreType).toBe('memory');
    expect(bundle.outboxStoreType).toBe('memory');
    expect(bundle.mappingStore).toBeInstanceOf(InMemoryMappingStore);
    expect(bundle.nonceStore).toBeInstanceOf(InMemoryNonceStore);
    expect(bundle.outbox).toBeInstanceOf(InMemoryEventOutbox);
    expect(bundle.close).toBeUndefined();
  });

  // M. sqlite bundle returns SqliteMappingStore instances (single store backs all three)
  it('M: createStoreBundle with sqlite returns SqliteMappingStore instances', () => {
    const bundle = createStoreBundle(devConfig('sqlite'));

    expect(bundle.storeType).toBe('sqlite');
    expect(bundle.nonceStoreType).toBe('sqlite');
    expect(bundle.outboxStoreType).toBe('sqlite');
    expect(bundle.mappingStore).toBeInstanceOf(SqliteMappingStore);
    // SqliteMappingStore implements all three interfaces — same instance backs them
    expect(bundle.nonceStore).toBe(bundle.mappingStore);
    expect(bundle.outbox).toBe(bundle.mappingStore);
    expect(typeof bundle.close).toBe('function');

    bundle.close!();
  });

  // N. memory rejected in production
  it('N: createStoreBundle rejects memory in production', () => {
    const cfg: StoreFactoryConfig = {
      storeType: 'memory',
      isProduction: true,
      allowSqliteInProduction: false,
    };
    expect(() => createStoreBundle(cfg)).toThrow(/memory.*not allowed in production/i);
  });

  // O. sqlite rejected in production without allow flag
  it('O: createStoreBundle rejects sqlite in production without allow flag', () => {
    const cfg: StoreFactoryConfig = {
      storeType: 'sqlite',
      sqlitePath: dbPath,
      isProduction: true,
      allowSqliteInProduction: false,
    };
    expect(() => createStoreBundle(cfg)).toThrow(/sqlite.*not allowed in production/i);
  });

  // P. sqlite allowed in production with allow flag
  it('P: createStoreBundle allows sqlite in production with allow flag', () => {
    const cfg: StoreFactoryConfig = {
      storeType: 'sqlite',
      sqlitePath: dbPath,
      isProduction: true,
      allowSqliteInProduction: true,
    };
    const bundle = createStoreBundle(cfg);
    expect(bundle.storeType).toBe('sqlite');
    expect(bundle.mappingStore).toBeInstanceOf(SqliteMappingStore);
    bundle.close!();
  });
});
