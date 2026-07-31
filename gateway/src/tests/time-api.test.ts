import { describe, it, expect, beforeEach, vi } from 'vitest';

import { makeApp, makeMockKimaiClient, signedRequest, type TestApp } from './helpers.js';

const FIRM1 = 'firm-11111111';
const FIRM2 = 'firm-22222222';
const USER1 = 'user-uuuuuuuu';
const CLIENT1 = 'client-cccccccc';
const MATTER1 = 'matter-mmmmmmmm';
const ACT = 'ACT-GEN';

describe('Time API (firm filtering, idempotency) — tests R–X', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  async function setupFirm(firmId: string, firmName: string, userId: string, clientId: string, matterId: string) {
    await t.service.initFirm({ scenticFirmId: firmId, firmName }, 'corr');
    await t.service.syncUser({ scenticFirmId: firmId, scenticUserId: userId, email: `${userId}@example.com` }, 'corr');
    await t.service.syncClient({ scenticFirmId: firmId, scenticClientId: clientId, clientName: `Client ${firmId}` }, 'corr');
    await t.service.syncMatter(
      { scenticFirmId: firmId, scenticMatterId: matterId, scenticClientId: clientId, matterName: `Matter ${firmId}` },
      'corr',
    );
  }

  // R. Create time entry requires Firm/User/Matter scope
  it('R: creating a time entry without scenticUserId returns 400', async () => {
    await setupFirm(FIRM1, 'Acme Law', USER1, CLIENT1, MATTER1);

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/time-entries`,
      bodyObj: {
        scenticMatterId: MATTER1,
        scenticActivityCode: ACT,
        scenticTimeEntryId: 'te-r',
        startAt: '2026-01-01T10:00:00',
      },
      firmId: FIRM1,
      idempotencyKey: 'idem-R',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  // S. Create time entry creates or uses mappings correctly
  it('S: with all mappings in place, a time entry is created and returned', async () => {
    await setupFirm(FIRM1, 'Acme Law', USER1, CLIENT1, MATTER1);

    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/time-entries`,
      bodyObj: {
        scenticUserId: USER1,
        scenticMatterId: MATTER1,
        scenticActivityCode: ACT,
        scenticTimeEntryId: 'te-s',
        startAt: '2026-01-01T10:00:00',
        durationSeconds: 3600,
        description: 'drafting',
      },
      firmId: FIRM1,
      idempotencyKey: 'idem-S',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.scenticTimeEntryId).toBe('te-s');
    expect(res.body.data.scenticFirmId).toBe(FIRM1);
    expect(res.body.data.kimaiTimesheetId).toBe(601);
  });

  // T. List time entries Firm-filtered
  it('T: listing time entries for firm1 does not include firm2 entries', async () => {
    await setupFirm(FIRM1, 'Acme Law', USER1, CLIENT1, MATTER1);
    await setupFirm(FIRM2, 'Beta Law', USER1, 'client-beta', 'matter-beta');

    await t.service.createTimeEntry(
      { scenticFirmId: FIRM1, scenticUserId: USER1, scenticMatterId: MATTER1, scenticActivityCode: ACT, scenticTimeEntryId: 'te-f1', startAt: '2026-01-01T10:00:00' },
      'corr',
    );
    await t.service.createTimeEntry(
      { scenticFirmId: FIRM2, scenticUserId: USER1, scenticMatterId: 'matter-beta', scenticActivityCode: ACT, scenticTimeEntryId: 'te-f2', startAt: '2026-01-02T10:00:00' },
      'corr',
    );

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: `/api/v1/firms/${FIRM1}/time-entries`,
      firmId: FIRM1,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].scenticFirmId).toBe(FIRM1);
    expect(res.body.data[0].scenticTimeEntryId).toBe('te-f1');
  });

  // U. Update time entry cannot cross Firm
  it('U: updating firm1 entry from a firm2 context returns 404', async () => {
    await setupFirm(FIRM1, 'Acme Law', USER1, CLIENT1, MATTER1);
    await setupFirm(FIRM2, 'Beta Law', USER1, 'client-beta', 'matter-beta');

    await t.service.createTimeEntry(
      { scenticFirmId: FIRM1, scenticUserId: USER1, scenticMatterId: MATTER1, scenticActivityCode: ACT, scenticTimeEntryId: 'te-cross', startAt: '2026-01-01T10:00:00' },
      'corr',
    );

    const res = await signedRequest(t.app, {
      method: 'PATCH',
      path: `/api/v1/firms/${FIRM2}/time-entries/te-cross`,
      bodyObj: { description: 'tampered' },
      firmId: FIRM2,
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // firm2 has no such mapping
    expect(t.store.getTimeEntryMapping(FIRM2, 'te-cross')).toBeNull();
  });

  // V. Delete time entry cannot cross Firm
  it('V: deleting firm1 entry from a firm2 context returns 404', async () => {
    await setupFirm(FIRM1, 'Acme Law', USER1, CLIENT1, MATTER1);
    await setupFirm(FIRM2, 'Beta Law', USER1, 'client-beta', 'matter-beta');

    await t.service.createTimeEntry(
      { scenticFirmId: FIRM1, scenticUserId: USER1, scenticMatterId: MATTER1, scenticActivityCode: ACT, scenticTimeEntryId: 'te-del', startAt: '2026-01-01T10:00:00' },
      'corr',
    );
    expect(t.store.getTimeEntryMapping(FIRM1, 'te-del')).not.toBeNull();

    const res = await signedRequest(t.app, {
      method: 'DELETE',
      path: `/api/v1/firms/${FIRM2}/time-entries/te-del`,
      firmId: FIRM2,
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // firm1 entry is untouched
    expect(t.store.getTimeEntryMapping(FIRM1, 'te-del')?.status).toBe('ACTIVE');
  });

  // W. Export time entries Firm-filtered
  it('W: export for firm1 only includes firm1 project IDs', async () => {
    // Use a client that returns distinct Kimai project IDs per createProject call.
    let projectId = 400;
    const client = makeMockKimaiClient({
      createProject: vi.fn(async (p: { name: string; customer: number }) => ({
        success: true,
        data: { id: ++projectId, name: p.name, customer: p.customer, visible: true, team: p.team },
      })),
    });
    const app = makeApp({ client });

    await app.service.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await app.service.syncUser({ scenticFirmId: FIRM1, scenticUserId: USER1, email: 'u@x.com' }, 'corr');
    await app.service.syncClient({ scenticFirmId: FIRM1, scenticClientId: CLIENT1, clientName: 'Acme Client' }, 'corr');
    await app.service.syncMatter({ scenticFirmId: FIRM1, scenticMatterId: MATTER1, scenticClientId: CLIENT1, matterName: 'Acme Matter' }, 'corr');

    await app.service.initFirm({ scenticFirmId: FIRM2, firmName: 'Beta Law' }, 'corr');
    await app.service.syncUser({ scenticFirmId: FIRM2, scenticUserId: USER1, email: 'u@x.com' }, 'corr');
    await app.service.syncClient({ scenticFirmId: FIRM2, scenticClientId: 'client-beta', clientName: 'Beta Client' }, 'corr');
    await app.service.syncMatter({ scenticFirmId: FIRM2, scenticMatterId: 'matter-beta', scenticClientId: 'client-beta', matterName: 'Beta Matter' }, 'corr');

    await app.service.createTimeEntry(
      { scenticFirmId: FIRM1, scenticUserId: USER1, scenticMatterId: MATTER1, scenticActivityCode: ACT, scenticTimeEntryId: 'te-w1', startAt: '2026-01-01T10:00:00' },
      'corr',
    );
    await app.service.createTimeEntry(
      { scenticFirmId: FIRM2, scenticUserId: USER1, scenticMatterId: 'matter-beta', scenticActivityCode: ACT, scenticTimeEntryId: 'te-w2', startAt: '2026-01-02T10:00:00' },
      'corr',
    );

    const firm1ProjectId = app.store.getMatterMapping(FIRM1, MATTER1)!.kimaiProjectId;
    const firm2ProjectId = app.store.getMatterMapping(FIRM2, 'matter-beta')!.kimaiProjectId;
    expect(firm1ProjectId).not.toBe(firm2ProjectId);

    client.exportTimesheets.mockClear();

    const res = await signedRequest(app.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/time-entries/export`,
      bodyObj: { format: 'csv' },
      firmId: FIRM1,
      idempotencyKey: 'idem-W',
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(client.exportTimesheets).toHaveBeenCalledTimes(1);
    const exportArg = client.exportTimesheets.mock.calls[0][0] as { project?: number[] };
    expect(exportArg.project).toContain(firm1ProjectId);
    expect(exportArg.project).not.toContain(firm2ProjectId);
  });

  // X. Idempotency prevents duplicate create
  it('X: creating with the same scenticTimeEntryId twice returns the existing mapping and only calls Kimai once', async () => {
    await setupFirm(FIRM1, 'Acme Law', USER1, CLIENT1, MATTER1);

    const first = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/time-entries`,
      bodyObj: {
        scenticUserId: USER1,
        scenticMatterId: MATTER1,
        scenticActivityCode: ACT,
        scenticTimeEntryId: 'te-idem',
        startAt: '2026-01-01T10:00:00',
      },
      firmId: FIRM1,
      idempotencyKey: 'idem-X',
    });
    expect(first.status).toBe(200);
    const firstId = first.body.data.id;
    const firstKimaiId = first.body.data.kimaiTimesheetId;

    const createTimesheetCallsAfterFirst = t.client.createTimesheet.mock.calls.length;

    const second = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM1}/time-entries`,
      bodyObj: {
        scenticUserId: USER1,
        scenticMatterId: MATTER1,
        scenticActivityCode: ACT,
        scenticTimeEntryId: 'te-idem',
        startAt: '2026-01-01T10:00:00',
      },
      firmId: FIRM1,
      idempotencyKey: 'idem-X2',
    });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(firstId);
    expect(second.body.data.kimaiTimesheetId).toBe(firstKimaiId);

    // No additional Kimai timesheet creation on the idempotent second call.
    expect(t.client.createTimesheet.mock.calls.length).toBe(createTimesheetCallsAfterFirst);
  });
});
