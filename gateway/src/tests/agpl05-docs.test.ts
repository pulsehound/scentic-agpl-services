/**
 * AGPL-05 — Docs tests (AG–AL).
 *
 * Verifies that all required documentation files exist and contain expected content.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const docsDir = path.join(repoRoot, 'docs');

describe('AGPL-05 docs — tests AG–AL', () => {
  // AG. Connection manual complete
  it('AG: SCENTIC_AGPL_CONNECTION_MANUAL.md exists and has content', () => {
    const p = path.join(docsDir, 'SCENTIC_AGPL_CONNECTION_MANUAL.md');
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content.length).toBeGreaterThan(5000);
  });

  // AH. Scentic required-change docs exist
  it('AH: SCENTIC_CORE_REQUIRED_CHANGES.md exists', () => {
    const p = path.join(docsDir, 'SCENTIC_CORE_REQUIRED_CHANGES.md');
    expect(existsSync(p)).toBe(true);
  });

  // AI. Production blockers doc exists
  it('AI: PRODUCTION_BLOCKERS.md exists', () => {
    const p = path.join(docsDir, 'PRODUCTION_BLOCKERS.md');
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('PB-01');
    expect(content).toContain('Scentic Core Integration');
  });

  // AJ. Deployment handoff exists
  it('AJ: AGPL_DEPLOYMENT_HANDOFF.md exists', () => {
    const p = path.join(docsDir, 'AGPL_DEPLOYMENT_HANDOFF.md');
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('LOCAL DEPLOYMENT PACKAGE COMPLETE');
    expect(content).toContain('PRODUCTION DEPLOYMENT NOT EXECUTED');
  });

  // AK. Final operator checklist exists
  it('AK: FINAL_OPERATOR_CHECKLIST.md exists', () => {
    const p = path.join(docsDir, 'FINAL_OPERATOR_CHECKLIST.md');
    expect(existsSync(p)).toBe(true);
    const content = readFileSync(p, 'utf-8');
    expect(content).toContain('Pre-Deployment');
    expect(content).toContain('Security Verification');
  });

  // AL. AGPL-05 closeout/evidence files exist
  it('AL: AGPL_05_CLOSEOUT.md and AGPL_05_EVIDENCE.md exist', () => {
    expect(existsSync(path.join(docsDir, 'AGPL_05_CLOSEOUT.md'))).toBe(true);
    expect(existsSync(path.join(docsDir, 'AGPL_05_EVIDENCE.md'))).toBe(true);
  });
});
