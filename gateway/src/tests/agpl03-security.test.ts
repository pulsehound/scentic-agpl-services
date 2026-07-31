import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import request from 'supertest';

import { makeApp, signedRequest, type TestApp } from './helpers.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const gatewaySrc = path.join(repoRoot, 'gateway', 'src');
const scentCoreDir = path.resolve(repoRoot, '..', 'scentic.ai');

const KIMAI_SHA = '7c2ed4b07cca2e15b1ab4cc5947afdf899a76401';
const OPENSIGN_SHA = 'f72624fa26211fe00776453d99a67120a4f5e060';

/**
 * Walks .ts/.js/.tsx files under a directory, skipping subtrees named
 * `tests`, `node_modules`, `dist`, or `vendor`.
 */
function walkSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['tests', 'node_modules', 'dist', 'vendor', 'fixtures'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, acc);
    } else if (/\.(ts|js|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Parses `git status --porcelain` output into an array of path strings,
 * stripping the 2-char status code + space and any surrounding quotes.
 */
function porcelainPaths(output: string): string[] {
  return output
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean)
    .map(line => {
      let rest = line.slice(3);
      if (rest.includes(' -> ')) rest = rest.split(' -> ')[1];
      if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
      return rest;
    });
}

describe('AGPL-03 security & boundary — tests A–D, AA–AK', () => {
  let t: TestApp;

  beforeEach(() => {
    t = makeApp({ enableWebhook: true, enableOpenSign: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A. Scentic core working tree not modified by AGPL-03
  it('A: Scentic core git status has no agpl/gateway/opensign references', () => {
    expect(existsSync(path.join(scentCoreDir, '.git'))).toBe(true);
    const status = execSync(`git -C "${scentCoreDir}" status --porcelain`, { encoding: 'utf-8' });
    const paths = porcelainPaths(status);

    const agplRefs = paths.filter(p =>
      /scentic-agpl-services/i.test(p) ||
      /\bagpl\b/i.test(p) ||
      /\/gateway\//i.test(p) ||
      /\/vendor\/(kimai|opensign)/i.test(p) ||
      /opensign/i.test(p),
    );

    expect(agplRefs).toEqual([]);
  });

  // B. No @scentic/* imports in AGPL gateway
  it('B: no gateway/src/ file imports @scentic/* or references scentic.ai', () => {
    const files = walkSourceFiles(gatewaySrc);
    expect(files.length).toBeGreaterThan(0);

    const forbidden = /@scentic\/|scentic\.ai/;
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf-8');
      if (forbidden.test(content)) {
        offenders.push(path.relative(gatewaySrc, f));
      }
    }

    expect(offenders).toEqual([]);
  });

  // C. No Scentic proprietary source copied into AGPL repo
  it('C: no tracked source file in the AGPL repo contains Scentic proprietary imports', () => {
    const files = walkSourceFiles(path.join(repoRoot, 'gateway'));
    // Also scan deploy/scripts at the repo root (exclude docs which legitimately
    // mention scentic.ai as the proprietary core).
    expect(files.length).toBeGreaterThan(0);

    const forbidden = /@scentic\/|from\s+['"]scentic\.ai/;
    const offenders: string[] = [];
    for (const f of files) {
      const content = readFileSync(f, 'utf-8');
      if (forbidden.test(content)) {
        offenders.push(path.relative(repoRoot, f));
      }
    }

    expect(offenders).toEqual([]);
  });

  // D. Scentic required changes documented only (no changes applied)
  it('D: docs/SCENTIC_CORE_REQUIRED_CHANGES.md exists and says "no changes applied"', () => {
    const file = path.join(repoRoot, 'docs', 'SCENTIC_CORE_REQUIRED_CHANGES.md');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');

    expect(content).toMatch(/no changes applied/i);
    expect(content).toMatch(/not modified|not applied|documentation only/i);
  });

  // AA. Secrets/tokens redacted in logs/status/events
  it('AA: GET /api/v1/status response contains no raw secrets', async () => {
    const res = await request(t.app).get('/api/v1/status');
    expect(res.status).toBe(200);

    const text = res.text;
    const secrets = [
      t.config.hmacSecret,
      t.config.webhookHmacSecret,
      t.config.kimaiAdminApiToken,
      t.config.opensignMasterKey,
      t.config.opensignAdminPassword,
    ];
    for (const s of secrets) {
      expect(text).not.toContain(s);
    }
  });

  // AB. Source-offer endpoint still excludes Scentic proprietary source
  it('AB: GET /source exposes no @scentic/ or scentic.ai proprietary references', async () => {
    const res = await signedRequest(t.app, { method: 'GET', path: '/source', firmId: 'firm-x' });
    expect(res.status).toBe(200);
    expect(res.body.data.license).toBe('AGPL-3.0');

    const text = res.text;
    expect(text).not.toContain('@scentic/');
    // The source-offer must not reference the proprietary scentic.ai package
    // surface. (Mentions of "Scentic" as a product name in the notice are
    // allowed, but `scentic.ai` as an import/package path is not.)
    expect(text).not.toMatch(/scentic\.ai/);
  });

  // AC. Webhook replay/idempotency documented and tested
  it('AC: webhook-dispatcher.test.ts covers idempotency', () => {
    const file = path.join(gatewaySrc, 'tests', 'webhook-dispatcher.test.ts');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');

    expect(content).toMatch(/Idempotency-Key/i);
    expect(content).toMatch(/idempoten/i);
  });

  // AD. Firm scope appears in every event and endpoint contract
  it('AD: webhook payload includes scenticFirmId on every dispatched event', async () => {
    const event = await t.outbox.publish({
      eventType: 'KIMAI_TIME_ENTRY_CREATED',
      scenticFirmId: 'firm-ad-test',
      correlationId: 'corr-ad',
      payload: { scenticTimeEntryId: 'te-ad' },
      safeSummary: 'Time entry created for firm-ad-test',
    });

    let capturedBody: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return new Response('ok', { status: 200 });
    });

    const result = await t.webhookDispatcher!.dispatchEvent(event);
    expect(result.status).toBe('DELIVERED');
    expect(capturedBody).toBeDefined();
    expect(capturedBody).toContain('"scenticFirmId":"firm-ad-test"');
  });

  // AE. Contract tests use generated test data only
  it('AE: test fixtures contain no real client data (test PDF is blank)', () => {
    const fixturePdf = path.join(gatewaySrc, 'tests', 'fixtures', 'test-document.pdf');
    expect(existsSync(fixturePdf)).toBe(true);
    const buf = readFileSync(fixturePdf);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const text = buf.toString('latin1');
    expect(text).not.toMatch(/@example\.com/i);
    expect(text).not.toContain('Acme');
    expect(text).not.toContain('Confidential');
    expect(text).not.toMatch(/client[-_ ]?name/i);
  });

  // AF. UPSTREAM_SOURCES.md still pins Kimai/OpenSign SHAs
  it('AF: docs/UPSTREAM_SOURCES.md pins both Kimai and OpenSign SHAs', () => {
    const file = path.join(repoRoot, 'docs', 'UPSTREAM_SOURCES.md');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');

    expect(content).toContain(KIMAI_SHA);
    expect(content).toContain(OPENSIGN_SHA);
  });

  // AG. README preserves AGPL/source-offer language
  it('AG: README.md preserves AGPL-3.0 and source-offer language', () => {
    const file = path.join(repoRoot, 'README.md');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');

    expect(content).toMatch(/AGPL-3\.0/i);
    expect(/source[_ -]?offer/i.test(content)).toBe(true);
  });

  // AH. No production-readiness claim
  it('AH: status endpoint says productionReadiness=false and README does not claim production-ready', async () => {
    const res = await request(t.app).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(res.body.data.gateway.productionReadiness).toBe(false);

    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
    // README must not claim the system is production-ready.
    expect(readme).not.toMatch(/production[_ -]?ready/i);
    expect(readme).not.toMatch(/\bproduction ready\b/i);
  });

  // AI. OpenSign license inconsistency still documented
  it('AI: GET /source documents the OpenSign license inconsistency via licenseNote', async () => {
    const res = await signedRequest(t.app, { method: 'GET', path: '/source', firmId: 'firm-x' });
    expect(res.status).toBe(200);

    const opensign = res.body.data.upstream.opensign;
    expect(opensign).toBeDefined();
    expect(opensign.licenseNote).toBeDefined();
    expect(typeof opensign.licenseNote).toBe('string');
    expect(opensign.licenseNote.length).toBeGreaterThan(0);
    expect(/AGPL/i.test(opensign.licenseNote)).toBe(true);
  });

  // AJ. AGPL-01 route count remains reconciled (16 routes)
  it('AJ: docs/AGPL_01_CLOSEOUT.md reconciles 16 REST routes', () => {
    const file = path.join(repoRoot, 'docs', 'AGPL_01_CLOSEOUT.md');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');

    // Count backtick-quoted HTTP method + path route entries that appear as
    // bulleted list items (the reconciled REST route list). The public-routes
    // summary line repeats /health and /source; restricting to bulleted
    // entries yields exactly the 16 reconciled routes.
    const routeMatches = content.match(/^\s*-\s+`(?:GET|POST|PATCH|DELETE)\s+\/[^`]+`/gm) ?? [];
    expect(routeMatches.length).toBe(16);
  });

  // AK. AGPL-03 closeout/evidence files created
  it('AK: docs/AGPL_03_CLOSEOUT.md and docs/AGPL_03_EVIDENCE.md exist', () => {
    const closeout = path.join(repoRoot, 'docs', 'AGPL_03_CLOSEOUT.md');
    const evidence = path.join(repoRoot, 'docs', 'AGPL_03_EVIDENCE.md');

    expect(existsSync(closeout)).toBe(true);
    expect(existsSync(evidence)).toBe(true);

    const closeoutContent = readFileSync(closeout, 'utf-8');
    expect(closeoutContent).toMatch(/AGPL-03/i);
    expect(closeoutContent).toMatch(/webhook/i);
  });
});
