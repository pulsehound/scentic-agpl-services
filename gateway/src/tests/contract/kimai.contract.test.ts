import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fixturePdf = path.join(repoRoot, 'gateway', 'src', 'tests', 'fixtures', 'test-document.pdf');

const KIMAI_CONTRACT_URL = process.env.CONTRACT_KIMAI_BASE_URL;

describe.skipIf(!KIMAI_CONTRACT_URL)('Kimai contract tests (require CONTRACT_KIMAI_BASE_URL) — tests P, R', () => {
  // P / R. When CONTRACT_KIMAI_BASE_URL is set, the configured service URL
  // must be reachable on a health endpoint.
  it('P/R: CONTRACT_KIMAI_BASE_URL is reachable on a health endpoint', async () => {
    expect(typeof KIMAI_CONTRACT_URL).toBe('string');
    const base = KIMAI_CONTRACT_URL!.replace(/\/$/, '');

    // Try a few common Kimai health/version endpoints. Kimai exposes
    // /api/version and /api/health under the API prefix; we accept any 2xx
    // or a structured 401 (which still proves the server is up).
    const probes = [
      `${base}/api/version`,
      `${base}/api/health`,
      `${base}/health`,
    ];

    let lastStatus = -1;
    let lastErr: unknown;
    for (const url of probes) {
      try {
        const resp = await fetch(url, { method: 'GET' });
        lastStatus = resp.status;
        // 2xx, or 401/403 (auth required) both prove reachability.
        if (resp.status < 500) {
          expect(resp.status).toBeLessThan(500);
          return;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    throw new Error(
      `Kimai contract probe failed for ${base}. lastStatus=${lastStatus}, lastErr=${String(lastErr)}`,
    );
  });
});

// S. Test PDF fixture contains no client data — this test always runs.
describe('Kimai test PDF fixture — test S', () => {
  it('S: test-document.pdf exists, is a valid PDF, and contains no client data', () => {
    expect(existsSync(fixturePdf)).toBe(true);

    const buf = readFileSync(fixturePdf);

    // Valid PDF header
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Scan the file bytes for any obvious client-data markers. The fixture is
    // a minimal blank PDF; it must not contain names, emails, matter codes,
    // or addresses. We assert the absence of common PII markers and confirm
    // the fixture is small (a blank page).
    const text = buf.toString('latin1');
    expect(text).not.toMatch(/client[-_ ]?name/i);
    expect(text).not.toMatch(/matter[-_ ]?name/i);
    expect(text).not.toMatch(/@example\.com/i);
    expect(text).not.toMatch(/@legal\./i);
    expect(text).not.toContain('Acme');
    expect(text).not.toContain('Confidential');

    // Sanity: fixture is a small blank PDF (well under 1KB).
    expect(buf.length).toBeLessThan(1024);
  });
});

// Always-running guard test that documents the skip reason when env is absent.
describe('Kimai contract env guard', () => {
  it('documents the CONTRACT_KIMAI_BASE_URL requirement', () => {
    if (!KIMAI_CONTRACT_URL) {
      // Env var missing — contract tests above are skipped by describe.skipIf.
      // This assertion documents the skip reason explicitly.
      expect(KIMAI_CONTRACT_URL).toBeUndefined();
    } else {
      expect(typeof KIMAI_CONTRACT_URL).toBe('string');
    }
  });
});
