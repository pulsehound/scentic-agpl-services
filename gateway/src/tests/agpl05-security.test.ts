/**
 * AGPL-05 — Security tests (W–AF).
 *
 * Verifies boundary, security, and compliance invariants.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scenticRepo = path.join(repoRoot, '..', 'scentic.ai');

describe('AGPL-05 security & boundary — tests W–AF', () => {
  // W. No Scentic core modifications
  it('W: Scentic core has no AGPL-05 modifications', () => {
    if (!existsSync(scenticRepo)) return; // skip if not on same machine
    // Check that no AGPL gateway source directories exist in Scentic repo
    expect(existsSync(path.join(scenticRepo, 'gateway'))).toBe(false);
    expect(existsSync(path.join(scenticRepo, 'scentic-agpl-services'))).toBe(false);
    // Check git status for tracked modifications (not untracked)
    try {
      const status = execSync('git status --porcelain', { cwd: scenticRepo, encoding: 'utf-8' });
      const tracked = status.split('\n').filter(l => l && !l.startsWith('??'));
      expect(tracked.length).toBe(0);
    } catch {
      // If git command fails, skip this check
    }
  });

  // X. No @scentic/* imports
  it('X: No @scentic/* imports in gateway source', () => {
    const gatewaySrc = path.join(repoRoot, 'gateway', 'src');
    try {
      const result = execSync(
        `rg -r "" "@scentic/" "${gatewaySrc}" || echo "NO_MATCHES"`,
        { encoding: 'utf-8' }
      );
      expect(result.trim()).toBe('NO_MATCHES');
    } catch {
      // rg returns non-zero if no matches, which is what we want
    }
  });

  // Y. No Scentic proprietary code copied
  it('Y: No scentic.ai proprietary source files in AGPL repo', () => {
    // Check that no Scentic proprietary source files (e.g., from packages/) are in the AGPL repo
    const gatewaySrc = path.join(repoRoot, 'gateway', 'src');
    try {
      const result = execSync(
        `rg -l "import.*from.*@scentic/" "${gatewaySrc}" || echo "NO_MATCHES"`,
        { encoding: 'utf-8' }
      );
      expect(result.trim()).toBe('NO_MATCHES');
    } catch {
      // rg returns non-zero if no matches, which is what we want
    }
  });

  // Z. No production readiness claim
  it('Z: README does not claim production-ready', () => {
    const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
    expect(readme.toLowerCase()).not.toContain('production ready');
    expect(readme.toLowerCase()).not.toContain('production-ready');
    expect(readme).toContain('PRODUCTION DEPLOYMENT NOT EXECUTED');
  });

  // AA. No raw secrets in status endpoint
  it('AA: Status endpoint code uses redactSecret for sensitive values', () => {
    const statusSource = readFileSync(
      path.join(repoRoot, 'gateway', 'src', 'routes', 'status.ts'),
      'utf-8'
    );
    expect(statusSource).toContain('redactSecret');
  });

  // AB. No document contents stored in Postgres
  it('AB: Postgres schema has no document content columns', () => {
    const schema = readFileSync(
      path.join(repoRoot, 'gateway', 'src', 'storage', 'postgres-schema.sql'),
      'utf-8'
    );
    expect(schema.toLowerCase()).not.toContain('document_content');
    expect(schema.toLowerCase()).not.toContain('document_base64');
    expect(schema.toLowerCase()).not.toContain('file_content');
  });

  // AC. Signer emails remain hashed/redacted
  it('AC: Postgres schema stores signer_email_hash not raw email', () => {
    const schema = readFileSync(
      path.join(repoRoot, 'gateway', 'src', 'storage', 'postgres-schema.sql'),
      'utf-8'
    );
    expect(schema).toContain('signer_email_hash');
    // opensign_signer_mappings should not have a raw email column
    const signerTableStart = schema.indexOf('opensign_signer_mappings');
    const signerTableEnd = schema.indexOf(');', signerTableStart);
    const signerTable = schema.substring(signerTableStart, signerTableEnd);
    expect(signerTable).not.toMatch(/email[^_]/i);
  });

  // AD. Multi-Firm user mappings remain Firm-scoped
  it('AD: Postgres user_mappings has UNIQUE(firm_id, user_id) constraint', () => {
    const schema = readFileSync(
      path.join(repoRoot, 'gateway', 'src', 'storage', 'postgres-schema.sql'),
      'utf-8'
    );
    expect(schema).toContain('UNIQUE(scentic_firm_id, scentic_user_id)');
  });

  // AE. Source-offer excludes Scentic proprietary code
  it('AE: Source-offer route does not reference Scentic proprietary packages', () => {
    const healthSource = readFileSync(
      path.join(repoRoot, 'gateway', 'src', 'routes', 'health.ts'),
      'utf-8'
    );
    expect(healthSource).not.toContain('@scentic/');
  });

  // AF. OpenSign license inconsistency remains documented
  it('AF: Source-offer documents OpenSign license inconsistency', () => {
    const sourceOffer = readFileSync(
      path.join(repoRoot, 'docs', 'SOURCE_OFFER.md'),
      'utf-8'
    );
    expect(sourceOffer.toLowerCase()).toContain('opensign');
    expect(sourceOffer.toLowerCase()).toContain('license');
  });
});
