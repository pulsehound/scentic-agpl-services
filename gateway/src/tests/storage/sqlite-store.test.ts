/**
 * AGPL-04 — SqliteMappingStore CRUD tests (A–K).
 *
 * Exercises every MappingStore method against a real better-sqlite3 database
 * backed by a temporary file. No mocks: the actual schema.sql is applied and
 * real SQL is executed.
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
  tempDir = mkdtempSync(join(tmpdir(), 'gateway-sqlite-test-'));
  dbPath = join(tempDir, 'test.db');
  store = new SqliteMappingStore(dbPath);
});

afterEach(async () => {
  await store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('AGPL-04 SqliteMappingStore CRUD — tests A–K', () => {

  // A. Firm mapping create + retrieve
  it('A: SqliteMappingStore creates firm mapping and retrieves it', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const created = await store.upsertFirmMapping(
      { scenticFirmId, firmName: 'Acme Law' },
      101,
      'Acme Law',
    );

    expect(created.id).toBeTruthy();
    expect(created.scenticFirmId).toBe(scenticFirmId);
    expect(created.kimaiTeamId).toBe(101);
    expect(created.kimaiTeamName).toBe('Acme Law');
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getFirmMapping(scenticFirmId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.kimaiTeamId).toBe(101);
    expect(fetched!.kimaiTeamName).toBe('Acme Law');
  });

  // B. Firm mapping upsert updates existing
  it('B: SqliteMappingStore upserts (updates) existing firm mapping', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    await store.upsertFirmMapping({ scenticFirmId, firmName: 'Acme Law' }, 101, 'Acme Law');

    const updated = await store.upsertFirmMapping(
      { scenticFirmId, firmName: 'Acme Law PLLC' },
      202,
      'Acme Law PLLC',
    );

    expect(updated.kimaiTeamId).toBe(202);
    expect(updated.kimaiTeamName).toBe('Acme Law PLLC');
    expect(updated.scenticFirmId).toBe(scenticFirmId);
    // Same record, not a duplicate
    expect(updated.id).toBe((await store.getFirmMapping(scenticFirmId))!.id);

    await store.disableFirmMapping(scenticFirmId);
    expect((await store.getFirmMapping(scenticFirmId))!.status).toBe('DISABLED');
  });

  // C. User mapping CRUD (create, get, disable)
  it('C: User mapping CRUD (create, get, disable)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const scenticUserId = `user-${crypto.randomUUID()}`;
    await store.upsertFirmMapping({ scenticFirmId, firmName: 'Firm C' }, 1, 'Firm C');

    const created = await store.upsertUserMapping(
      { scenticFirmId, scenticUserId, email: 'alice@example.com', firstName: 'Alice', lastName: 'Lawyer' },
      201,
      'alice',
      'kimai-token-secret',
    );

    expect(created.scenticFirmId).toBe(scenticFirmId);
    expect(created.scenticUserId).toBe(scenticUserId);
    expect(created.kimaiUserId).toBe(201);
    expect(created.kimaiUsername).toBe('alice');
    expect(created.kimaiApiToken).toBe('kimai-token-secret');
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getUserMapping(scenticFirmId, scenticUserId);
    expect(fetched).not.toBeNull();
    expect(fetched!.kimaiUserId).toBe(201);

    await store.disableUserMapping(scenticFirmId, scenticUserId);
    expect((await store.getUserMapping(scenticFirmId, scenticUserId))!.status).toBe('DISABLED');
  });

  // D. Client mapping CRUD (create, get)
  it('D: Client mapping CRUD (create, get)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const scenticClientId = `client-${crypto.randomUUID()}`;
    await store.upsertFirmMapping({ scenticFirmId, firmName: 'Firm D' }, 1, 'Firm D');

    const created = await store.upsertClientMapping(
      { scenticFirmId, scenticClientId, clientName: 'Globex Inc' },
      301,
      'Globex Inc',
    );

    expect(created.scenticClientId).toBe(scenticClientId);
    expect(created.kimaiCustomerId).toBe(301);
    expect(created.displayLabelUsed).toBe('Globex Inc');
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getClientMapping(scenticFirmId, scenticClientId);
    expect(fetched).not.toBeNull();
    expect(fetched!.kimaiCustomerId).toBe(301);
  });

  // E. Matter mapping CRUD (create, get, includes scenticClientId)
  it('E: Matter mapping CRUD (create, get, includes scenticClientId)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const scenticClientId = `client-${crypto.randomUUID()}`;
    const scenticMatterId = `matter-${crypto.randomUUID()}`;
    await store.upsertFirmMapping({ scenticFirmId, firmName: 'Firm E' }, 1, 'Firm E');

    const created = await store.upsertMatterMapping(
      { scenticFirmId, scenticMatterId, scenticClientId, matterName: 'Acquisition' },
      401,
      'Acquisition',
    );

    expect(created.scenticMatterId).toBe(scenticMatterId);
    expect(created.scenticClientId).toBe(scenticClientId);
    expect(created.kimaiProjectId).toBe(401);
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getMatterMapping(scenticFirmId, scenticMatterId);
    expect(fetched).not.toBeNull();
    expect(fetched!.scenticClientId).toBe(scenticClientId);
    expect(fetched!.kimaiProjectId).toBe(401);
  });

  // F. Activity mapping CRUD (create, get)
  it('F: Activity mapping CRUD (create, get)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const code = 'ACT-RESEARCH';
    await store.upsertFirmMapping({ scenticFirmId, firmName: 'Firm F' }, 1, 'Firm F');

    const created = await store.upsertActivityMapping(
      { scenticFirmId, scenticActivityCode: code, activityName: 'Research' },
      501,
    );

    expect(created.scenticActivityCode).toBe(code);
    expect(created.kimaiActivityId).toBe(501);
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getActivityMapping(scenticFirmId, code);
    expect(fetched).not.toBeNull();
    expect(fetched!.kimaiActivityId).toBe(501);
  });

  // G. Time entry mapping CRUD (create, update, delete/list, soft delete)
  it('G: Time entry mapping CRUD (create, update, delete/list, soft delete)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const scenticUserId = `user-${crypto.randomUUID()}`;
    const scenticMatterId = `matter-${crypto.randomUUID()}`;
    const scenticTimeEntryId = `te-${crypto.randomUUID()}`;
    await store.upsertFirmMapping({ scenticFirmId, firmName: 'Firm G' }, 1, 'Firm G');

    const created = await store.upsertTimeEntryMapping(
      {
        scenticFirmId, scenticUserId, scenticMatterId,
        scenticActivityCode: 'ACT-RESEARCH', scenticTimeEntryId,
        startAt: '2026-01-01T09:00:00Z', durationSeconds: 3600, description: 'drafting',
      },
      601,
    );

    expect(created.scenticTimeEntryId).toBe(scenticTimeEntryId);
    expect(created.kimaiTimesheetId).toBe(601);
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getTimeEntryMapping(scenticFirmId, scenticTimeEntryId);
    expect(fetched).not.toBeNull();
    expect(fetched!.kimaiTimesheetId).toBe(601);

    // update
    const beforeUpdate = fetched!.updatedAt;
    // Small delay to ensure updatedAt timestamp changes
    await new Promise(r => setTimeout(r, 10));
    await store.updateTimeEntryMapping(scenticFirmId, scenticTimeEntryId);
    const afterUpdate = await store.getTimeEntryMapping(scenticFirmId, scenticTimeEntryId);
    expect(afterUpdate!.updatedAt).not.toBe(beforeUpdate);

    // list (active)
    const listed = await store.listTimeEntryMappings({ scenticFirmId });
    expect(listed.length).toBe(1);
    expect(listed[0].scenticTimeEntryId).toBe(scenticTimeEntryId);

    // soft delete (DISABLED), excluded from list
    await store.deleteTimeEntryMapping(scenticFirmId, scenticTimeEntryId);
    expect((await store.getTimeEntryMapping(scenticFirmId, scenticTimeEntryId))!.status).toBe('DISABLED');
    expect((await store.listTimeEntryMappings({ scenticFirmId })).length).toBe(0);
  });

  // H. OpenSign firm mapping CRUD
  it('H: OpenSign firm mapping CRUD', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const created = await store.upsertOpenSignFirmMapping(
      { scenticFirmId, firmName: 'Acme Law' },
      'tenant-1',
      'Acme Law',
    );

    expect(created.scenticFirmId).toBe(scenticFirmId);
    expect(created.opensignTenantId).toBe('tenant-1');
    expect(created.opensignTenantName).toBe('Acme Law');
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getOpenSignFirmMapping(scenticFirmId);
    expect(fetched).not.toBeNull();
    expect(fetched!.opensignTenantId).toBe('tenant-1');

    // upsert update
    const updated = await store.upsertOpenSignFirmMapping(
      { scenticFirmId, firmName: 'Acme Law PLLC' },
      'tenant-2',
      'Acme Law PLLC',
    );
    expect(updated.opensignTenantId).toBe('tenant-2');
    expect(updated.opensignTenantName).toBe('Acme Law PLLC');

    await store.disableOpenSignFirmMapping(scenticFirmId);
    expect((await store.getOpenSignFirmMapping(scenticFirmId))!.status).toBe('DISABLED');
  });

  // I. OpenSign user mapping CRUD (includes email and session token)
  it('I: OpenSign user mapping CRUD (includes email and session token)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const scenticUserId = `user-${crypto.randomUUID()}`;
    await store.upsertOpenSignFirmMapping({ scenticFirmId, firmName: 'Firm I' }, 't', 'Firm I');

    const created = await store.upsertOpenSignUserMapping(
      { scenticFirmId, scenticUserId, email: 'bob@example.com', name: 'Bob' },
      'os-user-1',
      'session-token-secret',
    );

    expect(created.scenticUserId).toBe(scenticUserId);
    expect(created.opensignUserId).toBe('os-user-1');
    expect(created.opensignEmail).toBe('bob@example.com');
    expect(created.opensignSessionToken).toBe('session-token-secret');
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getOpenSignUserMapping(scenticFirmId, scenticUserId);
    expect(fetched).not.toBeNull();
    expect(fetched!.opensignEmail).toBe('bob@example.com');
    expect(fetched!.opensignSessionToken).toBe('session-token-secret');

    // upsert update (email + token rotate)
    const updated = await store.upsertOpenSignUserMapping(
      { scenticFirmId, scenticUserId, email: 'bob2@example.com', name: 'Bob' },
      'os-user-1',
      'session-token-rotated',
    );
    expect(updated.opensignEmail).toBe('bob2@example.com');
    expect(updated.opensignSessionToken).toBe('session-token-rotated');
  });

  // J. OpenSign workflow mapping CRUD (create, update status, list)
  it('J: OpenSign workflow mapping CRUD (create, update status, list)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const scenticSignatureWorkflowId = `sw-${crypto.randomUUID()}`;
    const scenticMatterId = `matter-${crypto.randomUUID()}`;
    const scenticDocumentId = `doc-${crypto.randomUUID()}`;
    const scenticDocumentVersionId = `dv-${crypto.randomUUID()}`;

    const created = await store.upsertOpenSignWorkflowMapping(
      {
        scenticFirmId, scenticSignatureWorkflowId, scenticMatterId,
        scenticDocumentId, scenticDocumentVersionId,
        scenticPhysicalFileId: 'pf-1', documentName: 'Agreement.pdf',
        documentBase64: 'base64', signers: [], sendNow: false,
      },
      'os-doc-1',
      'os-wf-1',
      'DRAFT',
    );

    expect(created.scenticSignatureWorkflowId).toBe(scenticSignatureWorkflowId);
    expect(created.opensignDocumentId).toBe('os-doc-1');
    expect(created.opensignWorkflowId).toBe('os-wf-1');
    expect(created.opensignStatus).toBe('DRAFT');
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    expect(fetched).not.toBeNull();
    expect(fetched!.opensignWorkflowId).toBe('os-wf-1');

    // update status
    await store.updateOpenSignWorkflowStatus(scenticFirmId, scenticSignatureWorkflowId, 'SENT');
    expect((await store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId))!.opensignStatus).toBe('SENT');

    // list
    const listed = await store.listOpenSignWorkflowMappings(scenticFirmId);
    expect(listed.length).toBe(1);
    expect(listed[0].opensignStatus).toBe('SENT');
  });

  // K. OpenSign signer mapping CRUD (includes email hash, not raw email)
  it('K: OpenSign signer mapping CRUD (includes email hash, not raw email)', async () => {
    const scenticFirmId = `firm-${crypto.randomUUID()}`;
    const scenticSignatureWorkflowId = `sw-${crypto.randomUUID()}`;
    const scenticSignerId = `signer-${crypto.randomUUID()}`;
    const rawEmail = 'carol@example.com';
    const emailHash = 'sha256-' + rawEmail; // placeholder hash; store stores whatever is passed

    const created = await store.upsertOpenSignSignerMapping(
      scenticFirmId, scenticSignatureWorkflowId, scenticSignerId,
      'os-signer-1', emailHash,
    );

    expect(created.scenticSignerId).toBe(scenticSignerId);
    expect(created.opensignSignerId).toBe('os-signer-1');
    expect(created.signerEmailHash).toBe(emailHash);
    expect(created.signerEmailHash).not.toBe(rawEmail);
    expect(created.status).toBe('ACTIVE');

    const fetched = await store.getOpenSignSignerMapping(scenticFirmId, scenticSignatureWorkflowId, scenticSignerId);
    expect(fetched).not.toBeNull();
    expect(fetched!.signerEmailHash).toBe(emailHash);

    // upsert update
    const updated = await store.upsertOpenSignSignerMapping(
      scenticFirmId, scenticSignatureWorkflowId, scenticSignerId,
      'os-signer-1', 'sha256-rotated',
    );
    expect(updated.signerEmailHash).toBe('sha256-rotated');
  });
});
