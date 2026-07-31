/**
 * AGPL-05 — Docker/local config tests (M–Q).
 *
 * Static checks on docker-compose.yml, scripts, and Dockerfiles.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('AGPL-05 Docker/local config — tests M–Q', () => {
  const composePath = path.join(repoRoot, 'deploy', 'docker-compose.yml');
  const compose = readFileSync(composePath, 'utf-8');

  // M. docker-compose includes gateway-postgres
  it('M: docker-compose includes gateway-postgres service', () => {
    expect(compose).toContain('gateway-postgres');
    expect(compose).toContain('postgres:16');
    expect(compose).toContain('gateway-pg-data');
  });

  // N. Docker gateway env uses GATEWAY_STORE_TYPE=postgres
  it('N: Docker gateway env uses GATEWAY_STORE_TYPE=postgres', () => {
    expect(compose).toContain('GATEWAY_STORE_TYPE=postgres');
    expect(compose).toContain('GATEWAY_DATABASE_URL');
  });

  // O. local healthcheck covers gateway, Postgres, Kimai, OpenSign, source
  it('O: local-healthcheck.sh checks all services', () => {
    const healthcheckPath = path.join(repoRoot, 'scripts', 'local-healthcheck.sh');
    const source = readFileSync(healthcheckPath, 'utf-8');
    expect(source).toContain('3101');
    expect(source).toContain('3199');
    expect(source).toContain('gateway-postgres');
    expect(source).toContain('8001');
    expect(source).toContain('8080');
    expect(source).toContain('/source');
  });

  // P. reset script warns before deleting volumes
  it('P: reset script warns before deleting volumes', () => {
    const resetPath = path.join(repoRoot, 'scripts', 'local-reset.sh');
    const source = readFileSync(resetPath, 'utf-8');
    expect(source).toContain('WARNING');
    expect(source).toContain('DESTRUCTIVE');
    expect(source).toContain('sleep');
    expect(source).toContain('Ctrl+C');
  });

  // Q. source route remains reachable locally
  it('Q: source-offer route is configured in gateway', () => {
    const appSource = readFileSync(
      path.join(repoRoot, 'gateway', 'src', 'app.ts'),
      'utf-8'
    );
    expect(appSource).toContain('createSourceOfferRouter');
    // docker-compose exposes gateway on port 3101
    expect(compose).toContain('3101:3101');
  });
});
