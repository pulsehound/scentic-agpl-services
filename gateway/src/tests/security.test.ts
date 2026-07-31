import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeApp, makeTestConfig, signedRequest, type TestApp } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const FIRM1 = 'firm-11111111';
const FIRM2 = 'firm-22222222';
const USER1 = 'user-uuuuuuuu';
const CLIENT1 = 'client-cccccccc';
const MATTER1 = 'matter-mmmmmmmm';
const ACT = 'ACT-GEN';

const KIMAI_SHA = '7c2ed4b07cca2e15b1ab4cc5947afdf899a76401';
const OPENSIGN_SHA = 'f72624fa26211fe00776453d99a67120a4f5e060';

describe('Security (firm isolation, secret hygiene, source offer, vendor pinning) — tests Y–AD', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp();
  });

  // Y. Wrong Firm cannot read another Firm's mappings
  it('Y: firm2 cannot read firm1 mappings (store lookups are firm-scoped)', async () => {
    const init = await t.service.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    expect(init.success).toBe(true);

    expect(await t.store.getFirmMapping(FIRM1)).not.toBeNull();
    expect(await t.store.getFirmMapping(FIRM2)).toBeNull();

    const list = await t.service.listTimeEntries({ scenticFirmId: FIRM2 }, 'corr');
    expect(list.success).toBe(true);
    if (list.success) {
      expect(list.data).toHaveLength(0);
    }
  });

  // Z. Logs/events do not include secrets
  it('Z: no outbox event payload or safeSummary contains secrets or tokens', async () => {
    await t.service.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await t.service.syncUser({ scenticFirmId: FIRM1, scenticUserId: USER1, email: 'u@example.com' }, 'corr');
    await t.service.syncClient({ scenticFirmId: FIRM1, scenticClientId: CLIENT1, clientName: 'Acme Client' }, 'corr');
    await t.service.syncMatter({ scenticFirmId: FIRM1, scenticMatterId: MATTER1, scenticClientId: CLIENT1, matterName: 'Acme Matter' }, 'corr');
    await t.service.createTimeEntry(
      { scenticFirmId: FIRM1, scenticUserId: USER1, scenticMatterId: MATTER1, scenticActivityCode: ACT, scenticTimeEntryId: 'te-z', startAt: '2026-01-01T10:00:00' },
      'corr',
    );

    const secrets = [
      t.config.hmacSecret,
      t.config.webhookHmacSecret,
      t.config.kimaiAdminApiToken,
    ];
    const events = await t.outbox.getAll();
    expect(events.length).toBeGreaterThan(0);

    for (const e of events) {
      const payloadStr = JSON.stringify(e.payload);
      for (const s of secrets) {
        expect(e.safeSummary).not.toContain(s);
        expect(payloadStr).not.toContain(s);
      }
    }

    // Also confirm the user mapping token never leaks into events.
    const userMapping = await t.store.getUserMapping(FIRM1, USER1);
    expect(userMapping).not.toBeNull();
    if (userMapping) {
      for (const e of events) {
        expect(JSON.stringify(e.payload)).not.toContain(userMapping.kimaiApiToken);
        expect(e.safeSummary).not.toContain(userMapping.kimaiApiToken);
      }
    }
  });

  // AA. Confidential-label mode avoids full matter/client names
  it('AA: with useConfidentialLabels=false, Kimai receives neutral codes instead of real names', async () => {
    const config = makeTestConfig({ useConfidentialLabels: false });
    const app = makeApp({ config });

    await app.service.initFirm({ scenticFirmId: FIRM1, firmName: 'Acme Law' }, 'corr');
    await app.service.syncClient(
      { scenticFirmId: FIRM1, scenticClientId: CLIENT1, clientName: 'Super Secret Client Inc' },
      'corr',
    );
    await app.service.syncMatter(
      { scenticFirmId: FIRM1, scenticMatterId: MATTER1, scenticClientId: CLIENT1, matterName: 'Merger X Confidential', matterCode: 'M-100' },
      'corr',
    );

    const customerCall = app.client.createCustomer.mock.calls[0]?.[0] as { name: string } | undefined;
    const projectCall = app.client.createProject.mock.calls[0]?.[0] as { name: string } | undefined;

    expect(customerCall).toBeDefined();
    expect(projectCall).toBeDefined();
    if (customerCall) {
      expect(customerCall.name).not.toContain('Super Secret Client Inc');
      expect(customerCall.name).toMatch(/^Client-/);
    }
    if (projectCall) {
      expect(projectCall.name).not.toContain('Merger X Confidential');
      expect(projectCall.name).toMatch(/^Matter-/);
    }

    // The real names must not appear in any outbox event either.
    for (const e of await app.outbox.getAll()) {
      expect(e.safeSummary).not.toContain('Super Secret Client Inc');
      expect(e.safeSummary).not.toContain('Merger X Confidential');
    }
  });

  // AB. Source endpoint does not expose secrets or Scentic proprietary code
  it('AB: GET /source exposes license info but no secrets and no Scentic proprietary package refs', async () => {
    const res = await signedRequest(t.app, { method: 'GET', path: '/source', firmId: FIRM1 });

    // /source is public; auth middleware skips it, so any firmId header is fine.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.license).toBe('AGPL-3.0');
    expect(res.body.data.upstream.kimai.pinnedCommit).toBe(KIMAI_SHA);
    expect(res.body.data.upstream.opensign.pinnedCommit).toBe(OPENSIGN_SHA);

    const text = res.text;
    expect(text).not.toContain(t.config.hmacSecret);
    expect(text).not.toContain(t.config.kimaiAdminApiToken);
    expect(text).not.toContain('@scentic/');
    expect(text).not.toContain('scentic.ai');
  });

  // AC. Direct mapping ID probing returns safe denial
  it('AC: probing a non-existent time entry returns 404, not 500', async () => {
    const res = await signedRequest(t.app, {
      method: 'DELETE',
      path: `/api/v1/firms/${FIRM1}/time-entries/does-not-exist`,
      firmId: FIRM1,
    });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  // AD. OpenSign remains untouched in AGPL-01
  it('AD: vendor/opensign is still checked out at the pinned AGPL-01 SHA', () => {
    const opensignDir = path.join(repoRoot, 'vendor', 'opensign');
    let head: string;
    try {
      head = execSync(`git -C "${opensignDir}" rev-parse HEAD`, { encoding: 'utf-8' }).trim();
    } catch (err) {
      throw new Error(`vendor/opensign is not a git repo at ${opensignDir}: ${err}`);
    }

    expect(head).toBe(OPENSIGN_SHA);
  });
});
