import { describe, it, expect } from 'vitest';

const KIMAI_CONTRACT_URL = process.env.CONTRACT_KIMAI_BASE_URL;
const OPENSIGN_CONTRACT_URL = process.env.CONTRACT_OPENSIGN_BASE_URL;

const BOTH_PRESENT = !!KIMAI_CONTRACT_URL && !!OPENSIGN_CONTRACT_URL;

describe.skipIf(!BOTH_PRESENT)('Local stack contract tests (require both CONTRACT_KIMAI_BASE_URL and CONTRACT_OPENSIGN_BASE_URL) — test R', () => {
  // R. When both env vars are present, verify both services are reachable.
  it('R: both Kimai and OpenSign contract URLs are reachable', async () => {
    expect(typeof KIMAI_CONTRACT_URL).toBe('string');
    expect(typeof OPENSIGN_CONTRACT_URL).toBe('string');

    async function probe(base: string, candidates: string[]): Promise<number> {
      const clean = base.replace(/\/$/, '');
      let lastStatus = -1;
      let lastErr: unknown;
      for (const suffix of candidates) {
        const url = suffix.startsWith('http') ? suffix : `${clean}${suffix}`;
        try {
          const resp = await fetch(url, { method: 'GET' });
          lastStatus = resp.status;
          if (resp.status < 500) return resp.status;
        } catch (err) {
          lastErr = err;
        }
      }
      throw new Error(
        `probe failed for ${clean}. lastStatus=${lastStatus}, lastErr=${String(lastErr)}`,
      );
    }

    const kimaiStatus = await probe(KIMAI_CONTRACT_URL!, ['/api/version', '/api/health', '/health']);
    expect(kimaiStatus).toBeLessThan(500);

    const opensignStatus = await probe(OPENSIGN_CONTRACT_URL!, [
      '/api/apps/opensign/classes/_User',
      '/health',
      '/api/health',
      '',
    ]);
    expect(opensignStatus).toBeLessThan(500);
  });
});

// Always-running guard test that documents the skip reason when env is absent.
describe('Local stack contract env guard', () => {
  it('documents the CONTRACT_*_BASE_URL requirement for the local stack', () => {
    if (!BOTH_PRESENT) {
      // At least one env var missing — local-stack contract test is skipped.
      const present = [KIMAI_CONTRACT_URL, OPENSIGN_CONTRACT_URL].filter(Boolean);
      expect(present.length).toBeLessThan(2);
    } else {
      expect(BOTH_PRESENT).toBe(true);
    }
  });
});
