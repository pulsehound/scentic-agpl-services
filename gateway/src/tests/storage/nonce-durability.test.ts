/**
 * AGPL-04 — nonce durability tests (Q–S).
 *
 * Verifies that the SqliteMappingStore-backed NonceStore provides replay
 * protection, survives restarts (close/reopen), and auto-cleans expired
 * nonces. Persistence tests use a temp file (not :memory:) so state survives
 * close/reopen.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqliteMappingStore } from '../../storage/sqlite-store.js';

let tempDir: string;
let dbPath: string;
let store: SqliteMappingStore;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'gateway-nonce-test-'));
  dbPath = join(tempDir, 'nonce.db');
  store = new SqliteMappingStore(dbPath);
});

afterEach(async () => {
  try { await store.close(); } catch { /* already closed */ }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AGPL-04 nonce durability — tests Q–S', () => {

  // Q. seen() returns false for new nonce, true for replay
  it('Q: Nonce seen() returns false for new nonce, true for replay', async () => {
    const nonce = `nonce-${crypto.randomUUID()}`;
    const ts = Date.now();

    expect(await store.seen(nonce, ts)).toBe(false);
    // Immediate replay of the same nonce must be rejected
    expect(await store.seen(nonce, ts)).toBe(true);
  });

  // R. Nonces persist across store close/reopen (simulate restart)
  it('R: Nonces persist across store close/reopen (simulate restart)', async () => {
    const nonce = `nonce-${crypto.randomUUID()}`;
    const ts = Date.now();

    expect(await store.seen(nonce, ts)).toBe(false);
    await store.close();

    // Reopen the same database file — a fresh process would do this
    const reopened = new SqliteMappingStore(dbPath);
    try {
      // Same nonce must still be recognised as seen (replay rejected)
      expect(await reopened.seen(nonce, ts)).toBe(true);
      // A new nonce is accepted
      expect(await reopened.seen(`nonce-${crypto.randomUUID()}`, ts)).toBe(false);
    } finally {
      await reopened.close();
    }
  });

  // S. Expired nonces are cleaned up automatically
  it('S: Expired nonces are cleaned up automatically', async () => {
    // Use a very short maxAge so we can expire nonces without a long wait.
    // Use a dedicated db file so the beforeEach store handle is unaffected.
    const shortMaxAge = 50;
    const localStore = new SqliteMappingStore(join(tempDir, 'short-maxage.db'), shortMaxAge);
    try {
      const oldNonce = `old-${crypto.randomUUID()}`;
      const ts = Date.now();
      expect(await localStore.seen(oldNonce, ts)).toBe(false);

      // Wait long enough for the nonce to exceed maxAgeMs.
      await new Promise(r => setTimeout(r, shortMaxAge + 30));

      // Trigger cleanup by calling seen() with a fresh nonce; the cleanup
      // step runs first and removes expired nonces.
      const freshNonce = `fresh-${crypto.randomUUID()}`;
      expect(await localStore.seen(freshNonce, Date.now())).toBe(false);

      // The expired nonce must have been purged, so re-submitting it is
      // accepted again (returns false, not a replay).
      expect(await localStore.seen(oldNonce, Date.now())).toBe(false);
    } finally {
      localStore.close();
    }
  });
});
