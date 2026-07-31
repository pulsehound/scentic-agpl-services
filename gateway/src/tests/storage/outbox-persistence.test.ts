/**
 * AGPL-04 — outbox persistence tests (T–V).
 *
 * Verifies that published events survive restarts, getPending() returns only
 * PENDING events, and markSent/markFailed update status correctly (with
 * markFailed incrementing retry and flipping to FAILED after maxRetries).
 * Uses a temp file so state survives close/reopen.
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
  tempDir = mkdtempSync(join(tmpdir(), 'gateway-outbox-test-'));
  dbPath = join(tempDir, 'outbox.db');
  store = new SqliteMappingStore(dbPath);
});

afterEach(async () => {
  try { await store.close(); } catch { /* already closed */ }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AGPL-04 outbox persistence — tests T–V', () => {

  // T. Published events persist across store close/reopen
  it('T: Published events persist across store close/reopen', async () => {
    const firmId = `firm-${crypto.randomUUID()}`;
    const event = await store.publish({
      eventType: 'KIMAI_TIME_ENTRY_CREATED',
      scenticFirmId: firmId,
      correlationId: 'corr-t',
      payload: { scenticTimeEntryId: 'te-t' },
      safeSummary: 'Time entry created',
    });

    expect(event.status).toBe('PENDING');
    expect(event.retryCount).toBe(0);
    expect(event.maxRetries).toBe(5);

    await store.close();

    const reopened = new SqliteMappingStore(dbPath);
    try {
      const all = await reopened.getAll();
      expect(all.length).toBe(1);
      expect(all[0].eventId).toBe(event.eventId);
      expect(all[0].eventType).toBe('KIMAI_TIME_ENTRY_CREATED');
      expect(all[0].scenticFirmId).toBe(firmId);
      expect(all[0].status).toBe('PENDING');
      expect(all[0].payload).toEqual({ scenticTimeEntryId: 'te-t' });
    } finally {
      await reopened.close();
    }
  });

  // U. getPending() returns only PENDING events
  it('U: getPending() returns only PENDING events', async () => {
    const firmId = `firm-${crypto.randomUUID()}`;
    const e1 = await store.publish({ eventType: 'KIMAI_TIME_ENTRY_CREATED', scenticFirmId: firmId, correlationId: 'c1', payload: {}, safeSummary: 's1' });
    const e2 = await store.publish({ eventType: 'KIMAI_TIME_ENTRY_UPDATED', scenticFirmId: firmId, correlationId: 'c2', payload: {}, safeSummary: 's2' });
    const e3 = await store.publish({ eventType: 'KIMAI_TIME_ENTRY_DELETED', scenticFirmId: firmId, correlationId: 'c3', payload: {}, safeSummary: 's3' });

    // Initially all pending
    expect((await store.getPending()).length).toBe(3);

    await store.markSent(e1.eventId);
    expect((await store.getPending()).length).toBe(2);
    expect((await store.getPending()).map(e => e.eventId)).not.toContain(e1.eventId);

    // Fail e2 until FAILED
    for (let i = 0; i < e2.maxRetries; i++) await store.markFailed(e2.eventId);
    expect((await store.getPending()).length).toBe(1);
    expect((await store.getPending())[0].eventId).toBe(e3.eventId);

    // getAll still returns everything regardless of status
    expect((await store.getAll()).length).toBe(3);
  });

  // V. markSent/markFailed update status; markFailed increments retry and sets FAILED after maxRetries
  it('V: markSent() and markFailed() update status correctly, markFailed increments retry and sets FAILED after maxRetries', async () => {
    const firmId = `firm-${crypto.randomUUID()}`;
    const e = await store.publish({ eventType: 'OPENSIGN_WORKFLOW_CREATED', scenticFirmId: firmId, correlationId: 'c-v', payload: {}, safeSummary: 's-v' });

    expect(e.maxRetries).toBe(5);

    // markSent flips to SENT
    await store.markSent(e.eventId);
    const sent = (await store.getAll()).find(x => x.eventId === e.eventId)!;
    expect(sent.status).toBe('SENT');
    expect(sent.retryCount).toBe(0);

    // A fresh event: markFailed increments retryCount and keeps PENDING until maxRetries
    const e2 = await store.publish({ eventType: 'OPENSIGN_WORKFLOW_SENT', scenticFirmId: firmId, correlationId: 'c-v2', payload: {}, safeSummary: 's-v2' });
    await store.markFailed(e2.eventId);
    let row = (await store.getAll()).find(x => x.eventId === e2.eventId)!;
    expect(row.retryCount).toBe(1);
    expect(row.status).toBe('PENDING'); // 1 < 5

    await store.markFailed(e2.eventId);
    await store.markFailed(e2.eventId);
    await store.markFailed(e2.eventId); // retryCount = 4
    row = (await store.getAll()).find(x => x.eventId === e2.eventId)!;
    expect(row.retryCount).toBe(4);
    expect(row.status).toBe('PENDING'); // 4 < 5

    await store.markFailed(e2.eventId); // retryCount = 5, >= maxRetries
    row = (await store.getAll()).find(x => x.eventId === e2.eventId)!;
    expect(row.retryCount).toBe(5);
    expect(row.status).toBe('FAILED'); // 5 >= 5
  });
});
