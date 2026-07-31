import { describe, it, expect, beforeEach } from 'vitest';

import { makeApp, type TestApp } from './helpers.js';

const FIRM1 = 'firm-11111111';
const FIRM2 = 'firm-22222222';
const USER1 = 'user-uuuuuuuu';
const CLIENT1 = 'client-cccccccc';
const MATTER1 = 'matter-mmmmmmmm';
const ACT_CODE = 'ACT-GENERAL';

describe('Mappings (firm scoping, idempotency) — tests H–M', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  async function initFirm(firmId: string, firmName: string) {
    const r = await t.service.initFirm({ scenticFirmId: firmId, firmName }, 'corr');
    expect(r.success).toBe(true);
    return r;
  }

  async function syncUser(firmId: string, userId: string) {
    const r = await t.service.syncUser(
      { scenticFirmId: firmId, scenticUserId: userId, email: `${userId}@example.com` },
      'corr',
    );
    expect(r.success).toBe(true);
    return r;
  }

  async function syncClient(firmId: string, clientId: string, name: string) {
    const r = await t.service.syncClient(
      { scenticFirmId: firmId, scenticClientId: clientId, clientName: name },
      'corr',
    );
    expect(r.success).toBe(true);
    return r;
  }

  async function syncMatter(firmId: string, matterId: string, clientId: string, name: string) {
    const r = await t.service.syncMatter(
      { scenticFirmId: firmId, scenticMatterId: matterId, scenticClientId: clientId, matterName: name },
      'corr',
    );
    return r;
  }

  // H. Firm mapping created idempotently
  it('H: initFirm twice returns the same mapping and only creates the team once', async () => {
    const first = await initFirm(FIRM1, 'Acme Law');
    expect(first.success).toBe(true);
    const firstMapping = first.data;
    expect(firstMapping.status).toBe('ACTIVE');

    const createTeamCallsBefore = t.client.createTeam.mock.calls.length;

    const second = await initFirm(FIRM1, 'Acme Law');
    expect(second.success).toBe(true);
    expect(second.data.id).toBe(firstMapping.id);
    expect(second.data.kimaiTeamId).toBe(firstMapping.kimaiTeamId);

    // No additional Kimai team creation on the idempotent second call.
    expect(t.client.createTeam.mock.calls.length).toBe(createTeamCallsBefore);
  });

  // I. User mapping is Firm-scoped
  it('I: a user mapping in firm1 is not visible from firm2', async () => {
    await initFirm(FIRM1, 'Acme Law');
    await syncUser(FIRM1, USER1);

    expect(await t.store.getUserMapping(FIRM1, USER1)).not.toBeNull();
    expect(await t.store.getUserMapping(FIRM2, USER1)).toBeNull();
  });

  // J. Same user can map separately in two Firms
  it('J: the same scenticUserId creates two distinct mappings in two firms', async () => {
    await initFirm(FIRM1, 'Acme Law');
    await initFirm(FIRM2, 'Beta Law');
    await syncUser(FIRM1, USER1);
    await syncUser(FIRM2, USER1);

    const m1 = await t.store.getUserMapping(FIRM1, USER1);
    const m2 = await t.store.getUserMapping(FIRM2, USER1);

    expect(m1).not.toBeNull();
    expect(m2).not.toBeNull();
    expect(m1!.id).not.toBe(m2!.id);
    expect(m1!.scenticFirmId).toBe(FIRM1);
    expect(m2!.scenticFirmId).toBe(FIRM2);
    expect(m1!.scenticUserId).toBe(USER1);
    expect(m2!.scenticUserId).toBe(USER1);
  });

  // K. Cross-Firm mapping use rejected
  it('K: creating a time entry in firm2 referencing firm1 matter is rejected', async () => {
    await initFirm(FIRM1, 'Acme Law');
    await syncUser(FIRM1, USER1);
    await syncClient(FIRM1, CLIENT1, 'Acme Client');
    await syncMatter(FIRM1, MATTER1, CLIENT1, 'Acme Matter');
    expect(await t.store.getMatterMapping(FIRM1, MATTER1)).not.toBeNull();

    await initFirm(FIRM2, 'Beta Law');
    await syncUser(FIRM2, USER1);

    // firm2 has no matter mapping for MATTER1.
    const r = await t.service.createTimeEntry(
      {
        scenticFirmId: FIRM2,
        scenticUserId: USER1,
        scenticMatterId: MATTER1,
        scenticActivityCode: ACT_CODE,
        scenticTimeEntryId: 'te-1',
        startAt: '2026-01-01T10:00:00',
      },
      'corr',
    );

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('INVALID_INPUT');
      expect(r.error.statusCode).toBe(400);
    }
  });

  // L. Client/Matter mapping cannot cross Firm
  it('L: syncing a matter in firm2 that references a firm1 client is rejected', async () => {
    await initFirm(FIRM1, 'Acme Law');
    await syncClient(FIRM1, CLIENT1, 'Acme Client');

    await initFirm(FIRM2, 'Beta Law');

    const r = await syncMatter(FIRM2, MATTER1, CLIENT1, 'Beta Matter');

    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe('INVALID_INPUT');
      // firm2 has no client mapping for CLIENT1
      expect(await t.store.getClientMapping(FIRM2, CLIENT1)).toBeNull();
    }
  });

  // M. TimeEntry mapping Firm scope enforced
  it('M: listTimeEntries only returns entries belonging to the requesting firm', async () => {
    // firm1 setup + entry
    await initFirm(FIRM1, 'Acme Law');
    await syncUser(FIRM1, USER1);
    await syncClient(FIRM1, CLIENT1, 'Acme Client');
    await syncMatter(FIRM1, MATTER1, CLIENT1, 'Acme Matter');
    const te1 = await t.service.createTimeEntry(
      {
        scenticFirmId: FIRM1,
        scenticUserId: USER1,
        scenticMatterId: MATTER1,
        scenticActivityCode: ACT_CODE,
        scenticTimeEntryId: 'te-firm1',
        startAt: '2026-01-01T10:00:00',
      },
      'corr',
    );
    expect(te1.success).toBe(true);

    // firm2 setup + entry (firm2 has its own client/matter)
    await initFirm(FIRM2, 'Beta Law');
    await syncUser(FIRM2, USER1);
    await syncClient(FIRM2, 'client-beta', 'Beta Client');
    await syncMatter(FIRM2, 'matter-beta', 'client-beta', 'Beta Matter');
    const te2 = await t.service.createTimeEntry(
      {
        scenticFirmId: FIRM2,
        scenticUserId: USER1,
        scenticMatterId: 'matter-beta',
        scenticActivityCode: ACT_CODE,
        scenticTimeEntryId: 'te-firm2',
        startAt: '2026-01-02T10:00:00',
      },
      'corr',
    );
    expect(te2.success).toBe(true);

    const firm1List = await t.service.listTimeEntries({ scenticFirmId: FIRM1 }, 'corr');
    const firm2List = await t.service.listTimeEntries({ scenticFirmId: FIRM2 }, 'corr');

    expect(firm1List.success).toBe(true);
    expect(firm2List.success).toBe(true);
    if (firm1List.success && firm2List.success) {
      expect(firm1List.data).toHaveLength(1);
      expect(firm1List.data[0].scenticFirmId).toBe(FIRM1);
      expect(firm1List.data[0].scenticTimeEntryId).toBe('te-firm1');

      expect(firm2List.data).toHaveLength(1);
      expect(firm2List.data[0].scenticFirmId).toBe(FIRM2);
      expect(firm2List.data[0].scenticTimeEntryId).toBe('te-firm2');
    }
  });
});
