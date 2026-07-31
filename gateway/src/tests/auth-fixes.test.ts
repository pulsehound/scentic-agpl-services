import { describe, it, expect, beforeEach } from 'vitest';

import { makeApp, signedRequest, type TestApp } from './helpers.js';

const FIRM_A = 'firm-aaaaaaaa';
const FIRM_B = 'firm-bbbbbbbb';
const USER1 = 'user-uuuuuuuu';
const CLIENT1 = 'client-cccccccc';
const MATTER1 = 'matter-mmmmmmmm';
const ACT = 'ACT-GEN';

describe('Auth fixes (path firm-scope, bodyless hash contract) — tests A–B', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // A. Route path Firm ID mismatch rejected by auth middleware (extractFirmIdFromPath fix)
  it('A: signed with firmId=A but path has firmId=B returns 403 FIRM_SCOPE_VIOLATION', async () => {
    // The auth middleware is mounted at the app level, so req.params.firmId is
    // NOT populated when the middleware runs. The extractFirmIdFromPath regex
    // must pull firmId=B out of the path and reject it because it differs from
    // the HMAC-signed firmId=A.
    const res = await signedRequest(t.app, {
      method: 'POST',
      path: `/api/v1/firms/${FIRM_B}/time-entries`,
      bodyObj: {
        scenticUserId: USER1,
        scenticMatterId: MATTER1,
        scenticActivityCode: ACT,
        scenticTimeEntryId: 'te-a',
        startAt: '2026-01-01T10:00:00',
      },
      firmId: FIRM_A,
      idempotencyKey: 'idem-A',
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FIRM_SCOPE_VIOLATION');
  });

  // B. Bodyless request canonical hash verified consistently
  it('B: GET and DELETE with no body succeed (bodyless hash contract JSON.stringify({}) === "{}")', async () => {
    // GET with no body — list endpoint returns 200.
    const getRes = await signedRequest(t.app, {
      method: 'GET',
      path: `/api/v1/firms/${FIRM_A}/time-entries`,
      firmId: FIRM_A,
    });
    expect(getRes.status).toBe(200);
    expect(getRes.body.ok).toBe(true);

    // Set up a time entry via the service so DELETE has something to delete.
    await t.service.initFirm({ scenticFirmId: FIRM_A, firmName: 'Acme Law' }, 'corr');
    await t.service.syncUser({ scenticFirmId: FIRM_A, scenticUserId: USER1, email: `${USER1}@example.com` }, 'corr');
    await t.service.syncClient({ scenticFirmId: FIRM_A, scenticClientId: CLIENT1, clientName: 'Acme Client' }, 'corr');
    await t.service.syncMatter(
      { scenticFirmId: FIRM_A, scenticMatterId: MATTER1, scenticClientId: CLIENT1, matterName: 'Acme Matter' },
      'corr',
    );
    await t.service.createTimeEntry(
      { scenticFirmId: FIRM_A, scenticUserId: USER1, scenticMatterId: MATTER1, scenticActivityCode: ACT, scenticTimeEntryId: 'te-del', startAt: '2026-01-01T10:00:00' },
      'corr',
    );

    // DELETE with no body — returns 200, proving the bodyless signature verified.
    const delRes = await signedRequest(t.app, {
      method: 'DELETE',
      path: `/api/v1/firms/${FIRM_A}/time-entries/te-del`,
      firmId: FIRM_A,
    });
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
  });
});
