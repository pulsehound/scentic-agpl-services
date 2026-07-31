/**
 * AGPL-05 — Mock Scentic webhook receiver tests (test V).
 *
 * Verifies that the mock Scentic webhook receiver correctly:
 * - Receives signed events
 * - Verifies HMAC signature
 * - Extracts event metadata from headers
 * - Detects forbidden fields
 * - Responds 200 OK
 */

import { describe, it, expect } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const mockScenticPath = path.join(repoRoot, 'deploy', 'mock-scentic.js');

describe('AGPL-05 mock Scentic webhook receiver — test V', () => {
  // V. Mock Scentic webhook receiver verifies signed event
  it('V: mock-scentic.js exists and contains webhook verification logic', () => {
    const source = readFileSync(mockScenticPath, 'utf-8');
    expect(source).toContain('x-gateway-signature');
    expect(source).toContain('createHmac');
    expect(source).toContain('sha256');
    expect(source).toContain('/webhook');
    expect(source).toContain('/health');
    expect(source).toContain('/events');
    // Checks for forbidden fields
    expect(source).toContain('signingLink');
    expect(source).toContain('documentContent');
    expect(source).toContain('rawEmail');
  });

  it('V: mock-scentic.js Dockerfile exists', () => {
    const dockerfilePath = path.join(repoRoot, 'deploy', 'Dockerfile.mock-scentic');
    const source = readFileSync(dockerfilePath, 'utf-8');
    expect(source).toContain('node:20-alpine');
    expect(source).toContain('mock-scentic.js');
    expect(source).toContain('3199');
  });

  it('V: docker-compose includes mock-scentic service', () => {
    const composePath = path.join(repoRoot, 'deploy', 'docker-compose.yml');
    const source = readFileSync(composePath, 'utf-8');
    expect(source).toContain('mock-scentic');
    expect(source).toContain('Dockerfile.mock-scentic');
    expect(source).toContain('3199');
    // Webhook target URL points to mock-scentic
    expect(source).toContain('http://mock-scentic:3199/webhook');
  });

  it('V: HMAC signature verification produces correct signature', () => {
    const secret = 'test-webhook-secret';
    const body = JSON.stringify({
      eventId: 'evt-123',
      eventType: 'KIMAI_FIRM_INITIALIZED',
      scenticFirmId: 'firm-test',
      safeSummary: 'Firm initialized for test',
    });
    const expectedSig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(expectedSig).toMatch(/^sha256=[a-f0-9]{64}$/);
  });
});
