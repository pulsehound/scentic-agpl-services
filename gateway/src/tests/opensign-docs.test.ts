import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeApp, signedRequest } from './helpers.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const docsDir = path.join(repoRoot, 'docs');

function readDoc(name: string): string {
  return readFileSync(path.join(docsDir, name), 'utf-8');
}

describe('OpenSign docs (contracts, mapping, connection, source offer, closeout) — tests AJ–AP', () => {

  // AJ. API_CONTRACTS.md updated for signature endpoints
  it('AJ: API_CONTRACTS.md documents the implemented /signature/ routes', () => {
    const text = readDoc('API_CONTRACTS.md');
    expect(text).toContain('/signature/');
    expect(text).toMatch(/signature\/workflows/);
    expect(text).toMatch(/signature\/init/);
    expect(text).toMatch(/signature\/users\/sync/);
  });

  // AK. OPENSIGN_MAPPING.md updated with verified API details
  it('AK: OPENSIGN_MAPPING.md references verified OpenSign API details (Parse Server, contracts_Document)', () => {
    const text = readDoc('OPENSIGN_MAPPING.md');
    expect(text).toMatch(/Parse Server/i);
    expect(text).toContain('contracts_Document');
    expect(text).toMatch(/getDocument/);
  });

  // AL. CONNECTION_MANUAL updated with OpenSign env vars
  it('AL: SCENTIC_AGPL_CONNECTION_MANUAL.md documents OpenSign environment variables', () => {
    const text = readDoc('SCENTIC_AGPL_CONNECTION_MANUAL.md');
    expect(text).toContain('OPENSIGN_BASE_URL');
    expect(text).toContain('OPENSIGN_MASTER_KEY');
  });

  // AM. SOURCE_OFFER updated for OpenSign license inconsistency
  it('AM: SOURCE_OFFER.md documents the OpenSign license inconsistency', () => {
    const text = readDoc('SOURCE_OFFER.md');
    expect(text).toMatch(/OpenSign.*license.*inconsistency/i);
    expect(text).toMatch(/AGPL-3.0/i);
  });

  // AN. OpenSign license inconsistency documented (AGPL-3.0 vs MIT)
  it('AN: SOURCE_OFFER.md records the AGPL-3.0 vs MIT conflict in OpenSign', () => {
    const text = readDoc('SOURCE_OFFER.md');
    expect(text).toMatch(/AGPL-3.0/);
    expect(text).toMatch(/\bMIT\b/);
    // The doc must explain that AGPL-3.0 governs despite the MIT declaration.
    expect(text).toMatch(/conservatively.*AGPL|AGPL.*conservatively|treated.*AGPL-3.0/i);
  });

  // AO. Route count documentation reconciled — 16 routes, not 17
  it('AO: AGPL_01_CLOSEOUT.md lists exactly 16 REST API endpoints (not 17)', () => {
    const text = readDoc('AGPL_01_CLOSEOUT.md');
    // Extract the "REST API endpoints" bullet list and count route entries.
    // The section header is `- **REST API endpoints**` and route bullets look
    // like `  - \`GET /health\` — ...` (backtick-quoted method + path).
    const sectionMatch = text.match(/\*\*REST API endpoints\*\*[\s\S]*?(?=\n- \*\*|\n## )/);
    expect(sectionMatch, 'AGPL_01_CLOSEOUT.md must contain a REST API endpoints section').not.toBeNull();
    const section = sectionMatch![0];
    const routeLines = section
      .split('\n')
      .filter(l => /^\s*-\s+`(GET|POST|PATCH|DELETE|PUT)\b/i.test(l));
    expect(routeLines.length).toBe(16);
    expect(routeLines.length).not.toBe(17);
  });

  // AP. All AGPL-01 Kimai/auth/mapping/time tests still pass (regression smoke)
  it('AP: AGPL-01 patterns still work — signed init request returns 200', async () => {
    const t = makeApp();
    const res = await signedRequest(t.app, {
      method: 'POST',
      path: '/api/v1/firms/firm-regression/init',
      bodyObj: { firmName: 'Regression Law' },
      firmId: 'firm-regression',
      idempotencyKey: 'idem-AP',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.scenticFirmId).toBe('firm-regression');
  });
});
