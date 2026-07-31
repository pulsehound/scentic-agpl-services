import { describe, it, expect, beforeEach } from 'vitest';

import { makeApp, signedRequest, type TestApp } from './helpers.js';

const FIRM1 = 'firm-11111111';
const USER1 = 'user-uuuuuuuu';
const CLIENT1 = 'client-cccccccc';
const MATTER1 = 'matter-mmmmmmmm';

describe('AGPL-03 regression smoke — tests Y–Z', () => {
  let t: TestApp;

  beforeEach(() => {
    // Build an app with both Kimai (AGPL-01) and OpenSign (AGPL-02) enabled.
    t = makeApp({ enableOpenSign: true });
  });

  // Y. All AGPL-01 Kimai tests still pass (smoke)
  it('Y: signed GET /api/v1/providers/kimai/health returns 200 (AGPL-01 Kimai smoke)', async () => {
    // Initialize a firm + mappings so the Kimai service has state.
    await t.service.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.service.syncUser({ scenticFirmId: FIRM1, scenticUserId: USER1, email: `${USER1}@example.com` }, 'corr');
    await t.service.syncClient({ scenticFirmId: FIRM1, scenticClientId: CLIENT1, clientName: 'Acme Client' }, 'corr');
    await t.service.syncMatter(
      { scenticFirmId: FIRM1, scenticMatterId: MATTER1, scenticClientId: CLIENT1, matterName: 'Acme Matter' },
      'corr',
    );

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: '/api/v1/providers/kimai/health',
      firmId: FIRM1,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  // Z. All AGPL-02 OpenSign tests still pass (smoke)
  it('Z: signed GET /api/v1/providers/opensign/health returns 200 (AGPL-02 OpenSign smoke)', async () => {
    // Initialize the OpenSign firm so the service has state.
    await t.opensignService!.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');

    const res = await signedRequest(t.app, {
      method: 'GET',
      path: '/api/v1/providers/opensign/health',
      firmId: FIRM1,
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
