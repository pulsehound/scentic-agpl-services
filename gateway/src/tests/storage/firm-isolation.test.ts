/**
 * AGPL-04 — cross-firm isolation tests (W–Z).
 *
 * Verifies that mapping queries are firm-scoped at the SQL layer: data created
 * under one firm is never returned by queries scoped to a different firm.
 * This is a security-critical property for a multi-firm system.
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
  tempDir = mkdtempSync(join(tmpdir(), 'gateway-firm-iso-test-'));
  dbPath = join(tempDir, 'isolation.db');
  store = new SqliteMappingStore(dbPath);
});

afterEach(async () => {
  await store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

const FIRM1 = 'firm-aaaaaaaa';
const FIRM2 = 'firm-bbbbbbbb';

describe('AGPL-04 cross-firm isolation (SQLite) — tests W–Z', () => {
  beforeEach(async () => {
    // Seed both firms
    await store.upsertFirmMapping({ scenticFirmId: FIRM1, firmName: 'Firm One' }, 11, 'Firm One');
    await store.upsertFirmMapping({ scenticFirmId: FIRM2, firmName: 'Firm Two' }, 22, 'Firm Two');
  });

  // W. Firm1 mappings not visible to firm2 queries
  it('W: Firm1 mappings not visible to firm2 queries', async () => {
    // Firm1 user/client/matter exist
    await store.upsertUserMapping(
      { scenticFirmId: FIRM1, scenticUserId: 'u1', email: 'u1@firm1.test' },
      201, 'u1', 'token-1',
    );
    await store.upsertClientMapping(
      { scenticFirmId: FIRM1, scenticClientId: 'c1', clientName: 'Client1' },
      301, 'Client1',
    );

    // Querying firm2 must not see firm1's records
    expect(await store.getUserMapping(FIRM2, 'u1')).toBeNull();
    expect(await store.getClientMapping(FIRM2, 'c1')).toBeNull();
    expect(await store.getMatterMapping(FIRM2, 'm1')).toBeNull();
    expect(await store.getActivityMapping(FIRM2, 'a1')).toBeNull();

    // Firm mapping itself is keyed by scenticFirmId, so firm1's row is distinct
    expect((await store.getFirmMapping(FIRM1))!.kimaiTeamId).toBe(11);
    expect((await store.getFirmMapping(FIRM2))!.kimaiTeamId).toBe(22);
  });

  // X. User mappings are firm-scoped (same user id in two firms is isolated)
  it('X: User mappings are firm-scoped (firm1 user not found in firm2)', async () => {
    // Same scenticUserId in both firms — must be separate rows
    await store.upsertUserMapping(
      { scenticFirmId: FIRM1, scenticUserId: 'shared-user', email: 'shared@firm1.test' },
      201, 'shared1', 'token-firm1',
    );
    await store.upsertUserMapping(
      { scenticFirmId: FIRM2, scenticUserId: 'shared-user', email: 'shared@firm2.test' },
      202, 'shared2', 'token-firm2',
    );

    const f1 = await store.getUserMapping(FIRM1, 'shared-user');
    const f2 = await store.getUserMapping(FIRM2, 'shared-user');

    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(f1!.kimaiUserId).toBe(201);
    expect(f2!.kimaiUserId).toBe(202);
    expect(f1!.kimaiApiToken).toBe('token-firm1');
    expect(f2!.kimaiApiToken).toBe('token-firm2');
    expect(f1!.id).not.toBe(f2!.id);
  });

  // Y. Time entry listings are firm-scoped
  it('Y: Time entry listings are firm-scoped', async () => {
    await store.upsertTimeEntryMapping(
      { scenticFirmId: FIRM1, scenticUserId: 'u1', scenticMatterId: 'm1', scenticActivityCode: 'a1', scenticTimeEntryId: 'te1', startAt: '2026-01-01T00:00:00Z' },
      601,
    );
    await store.upsertTimeEntryMapping(
      { scenticFirmId: FIRM1, scenticUserId: 'u1', scenticMatterId: 'm1', scenticActivityCode: 'a1', scenticTimeEntryId: 'te2', startAt: '2026-01-02T00:00:00Z' },
      602,
    );
    await store.upsertTimeEntryMapping(
      { scenticFirmId: FIRM2, scenticUserId: 'u2', scenticMatterId: 'm2', scenticActivityCode: 'a2', scenticTimeEntryId: 'te3', startAt: '2026-01-03T00:00:00Z' },
      603,
    );

    const f1List = await store.listTimeEntryMappings({ scenticFirmId: FIRM1 });
    const f2List = await store.listTimeEntryMappings({ scenticFirmId: FIRM2 });

    expect(f1List.length).toBe(2);
    expect(f1List.map(e => e.scenticTimeEntryId).sort()).toEqual(['te1', 'te2']);
    expect(f1List.every(e => e.scenticFirmId === FIRM1)).toBe(true);

    expect(f2List.length).toBe(1);
    expect(f2List[0].scenticTimeEntryId).toBe('te3');
    expect(f2List.every(e => e.scenticFirmId === FIRM2)).toBe(true);

    // Firm1 listing filtered by user still excludes firm2 entries with same userId
    await store.upsertTimeEntryMapping(
      { scenticFirmId: FIRM2, scenticUserId: 'u1', scenticMatterId: 'm2', scenticActivityCode: 'a2', scenticTimeEntryId: 'te4', startAt: '2026-01-04T00:00:00Z' },
      604,
    );
    const f1ByUser = await store.listTimeEntryMappings({ scenticFirmId: FIRM1, scenticUserId: 'u1' });
    expect(f1ByUser.length).toBe(2);
    expect(f1ByUser.every(e => e.scenticFirmId === FIRM1)).toBe(true);
  });

  // Z. OpenSign workflow listings are firm-scoped
  it('Z: OpenSign workflow listings are firm-scoped', async () => {
    const mk = async (firm: string, wfId: string) => await store.upsertOpenSignWorkflowMapping(
      {
        scenticFirmId: firm, scenticSignatureWorkflowId: wfId, scenticMatterId: 'm',
        scenticDocumentId: 'd', scenticDocumentVersionId: 'dv',
        scenticPhysicalFileId: 'pf', documentName: 'n', documentBase64: 'b', signers: [], sendNow: false,
      },
      'os-doc', 'os-wf', 'DRAFT',
    );

    await mk(FIRM1, 'sw1');
    await mk(FIRM1, 'sw2');
    await mk(FIRM2, 'sw3');

    const f1List = await store.listOpenSignWorkflowMappings(FIRM1);
    const f2List = await store.listOpenSignWorkflowMappings(FIRM2);

    expect(f1List.length).toBe(2);
    expect(f1List.map(e => e.scenticSignatureWorkflowId).sort()).toEqual(['sw1', 'sw2']);
    expect(f1List.every(e => e.scenticFirmId === FIRM1)).toBe(true);

    expect(f2List.length).toBe(1);
    expect(f2List[0].scenticSignatureWorkflowId).toBe('sw3');
    expect(f2List.every(e => e.scenticFirmId === FIRM2)).toBe(true);
  });
});
