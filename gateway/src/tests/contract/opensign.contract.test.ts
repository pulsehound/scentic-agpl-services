import { describe, it, expect } from 'vitest';

const OPENSIGN_CONTRACT_URL = process.env.CONTRACT_OPENSIGN_BASE_URL;

describe.skipIf(!OPENSIGN_CONTRACT_URL)('OpenSign contract tests (require CONTRACT_OPENSIGN_BASE_URL) — test Q', () => {
  // Q. When CONTRACT_OPENSIGN_BASE_URL is set, verify basic connectivity.
  it('Q: CONTRACT_OPENSIGN_BASE_URL is reachable on a basic endpoint', async () => {
    expect(typeof OPENSIGN_CONTRACT_URL).toBe('string');
    const base = OPENSIGN_CONTRACT_URL!.replace(/\/$/, '');

    // OpenSign is a Parse Server app. Probe a few likely endpoints. A 2xx or
    // any structured non-5xx (e.g. 403/404 from Parse) proves reachability.
    const probes = [
      `${base}/api/apps/opensign/classes/_User`,
      `${base}/health`,
      `${base}/api/health`,
      base,
    ];

    let lastStatus = -1;
    let lastErr: unknown;
    for (const url of probes) {
      try {
        const resp = await fetch(url, { method: 'GET' });
        lastStatus = resp.status;
        if (resp.status < 500) {
          expect(resp.status).toBeLessThan(500);
          return;
        }
      } catch (err) {
        lastErr = err;
      }
    }

    throw new Error(
      `OpenSign contract probe failed for ${base}. lastStatus=${lastStatus}, lastErr=${String(lastErr)}`,
    );
  });
});

// Always-running guard test that documents the skip reason when env is absent.
describe('OpenSign contract env guard', () => {
  it('documents the CONTRACT_OPENSIGN_BASE_URL requirement', () => {
    if (!OPENSIGN_CONTRACT_URL) {
      expect(OPENSIGN_CONTRACT_URL).toBeUndefined();
    } else {
      expect(typeof OPENSIGN_CONTRACT_URL).toBe('string');
    }
  });
});
