/**
 * Store factory — creates the appropriate store implementation based on config.
 *
 * Config via env:
 * GATEWAY_STORE_TYPE=memory|sqlite|postgres (default: memory)
 * GATEWAY_SQLITE_PATH=path to SQLite file (default: ./gateway-state.db)
 * GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=false (default: false)
 *
 * Production rules:
 * - memory store rejected in production
 * - SQLite rejected in production unless GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true
 * - postgres not yet implemented (documented as AGPL-05 production blocker)
 */

import type { MappingStore } from '../mappings/mapping-store.js';
import type { NonceStore } from '../auth/hmac.js';
import type { EventOutbox } from '../events/outbox.js';
import { InMemoryMappingStore } from '../mappings/mapping-store.js';
import { InMemoryNonceStore } from '../auth/hmac.js';
import { InMemoryEventOutbox } from '../events/outbox.js';
import { SqliteMappingStore } from './sqlite-store.js';

export type StoreType = 'memory' | 'sqlite' | 'postgres';

export interface StoreBundle {
  mappingStore: MappingStore;
  nonceStore: NonceStore;
  outbox: EventOutbox;
  storeType: StoreType;
  nonceStoreType: 'memory' | 'sqlite' | 'redis';
  outboxStoreType: 'memory' | 'sqlite' | 'postgres';
  close?: () => void;
}

export interface StoreFactoryConfig {
  storeType: StoreType;
  sqlitePath?: string;
  isProduction: boolean;
  allowSqliteInProduction: boolean;
  redisUrl?: string;
}

export function createStoreBundle(config: StoreFactoryConfig): StoreBundle {
  if (config.isProduction) {
    if (config.storeType === 'memory') {
      throw new Error('GATEWAY_STORE_TYPE=memory is not allowed in production. Use sqlite or postgres.');
    }
    if (config.storeType === 'sqlite' && !config.allowSqliteInProduction) {
      throw new Error('GATEWAY_STORE_TYPE=sqlite is not allowed in production unless GATEWAY_ALLOW_SQLITE_IN_PRODUCTION=true. Use postgres for production.');
    }
  }

  if (config.storeType === 'memory') {
    if (!config.isProduction) {
      console.warn('[gateway] WARNING: Using in-memory store. Data will be lost on restart. Not suitable for production.');
    }
    return {
      mappingStore: new InMemoryMappingStore(),
      nonceStore: new InMemoryNonceStore(),
      outbox: new InMemoryEventOutbox(),
      storeType: 'memory',
      nonceStoreType: 'memory',
      outboxStoreType: 'memory',
    };
  }

  if (config.storeType === 'sqlite') {
    const path = config.sqlitePath ?? './gateway-state.db';
    const store = new SqliteMappingStore(path);
    return {
      mappingStore: store,
      nonceStore: store,
      outbox: store,
      storeType: 'sqlite',
      nonceStoreType: 'sqlite',
      outboxStoreType: 'sqlite',
      close: () => store.close(),
    };
  }

  // postgres — not yet implemented
  throw new Error('GATEWAY_STORE_TYPE=postgres is not yet implemented. Use sqlite for local/dev or memory for tests.');
}

export function createStoreConfigFromEnv(env: Record<string, string | undefined>): StoreFactoryConfig {
  const nodeEnv = (env['NODE_ENV'] ?? 'development').toLowerCase();
  const storeType = (env['GATEWAY_STORE_TYPE'] ?? 'memory').toLowerCase() as StoreType;
  const isProduction = nodeEnv === 'production';
  const allowSqliteInProduction = (env['GATEWAY_ALLOW_SQLITE_IN_PRODUCTION'] ?? 'false').toLowerCase() === 'true';

  return {
    storeType,
    sqlitePath: env['GATEWAY_SQLITE_PATH'],
    isProduction,
    allowSqliteInProduction,
    redisUrl: env['GATEWAY_REDIS_URL'],
  };
}
