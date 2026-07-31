import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const gatewaySrc = path.join(repoRoot, 'gateway', 'src');

const KIMAI_SHA = '7c2ed4b07cca2e15b1ab4cc5947afdf899a76401';
const OPENSIGN_SHA = 'f72624fa26211fe00776453d99a67120a4f5e060';

/**
 * Walks .ts files under a directory, skipping any subtree named `tests`.
 */
function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'tests' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts')) {
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
      // Format: "XY PATH" or "XY PATH -> TARGET" (renames)
      let rest = line.slice(3); // drop "XY " (2 status chars + space)
      if (rest.includes(' -> ')) rest = rest.split(' -> ')[1];
      if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
      return rest;
    });
}

describe('Docs & repo hygiene scans — tests AE–AJ', () => {
  // AE. UPSTREAM_SOURCES.md includes exact pinned SHAs
  it('AE: UPSTREAM_SOURCES.md pins the exact Kimai and OpenSign commit SHAs', () => {
    const file = path.join(repoRoot, 'docs', 'UPSTREAM_SOURCES.md');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');

    expect(content).toContain(KIMAI_SHA);
    expect(content).toContain(OPENSIGN_SHA);
    expect(content).toMatch(/kimai/i);
    expect(content).toMatch(/opensign/i);
  });

  // AF. LICENSE is AGPL-3.0
  it('AF: LICENSE first line declares the GNU AGPL-3.0 license', () => {
    const file = path.join(repoRoot, 'LICENSE');
    expect(existsSync(file)).toBe(true);
    const firstLine = readFileSync(file, 'utf-8').split('\n')[0];

    expect(firstLine).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
  });

  // AG. README contains source-offer language
  it('AG: README.md contains source-offer language', () => {
    const file = path.join(repoRoot, 'README.md');
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf-8');

    expect(/source[_ -]?offer/i.test(content)).toBe(true);
  });

  // AH. No Scentic core source copied into AGPL repo
  it('AH: no gateway source file imports from @scentic/* or scentic.ai', () => {
    const files = walkTsFiles(gatewaySrc);
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

  // AI. No AGPL dependency added to Scentic core
  it('AI: the Scentic core repo has no AGPL/gateway-related changes', () => {
    const scentCoreDir = path.resolve(repoRoot, '..', 'scentic.ai');
    expect(existsSync(path.join(scentCoreDir, '.git'))).toBe(true);

    const status = execSync(`git -C "${scentCoreDir}" status --porcelain`, { encoding: 'utf-8' });
    const paths = porcelainPaths(status);

    // No path in Scentic core should reference the AGPL repo or its gateway.
    const agplRefs = paths.filter(p =>
      /scentic-agpl-services/i.test(p) || /\bagpl\b/i.test(p) || /gateway/i.test(p),
    );

    expect(agplRefs).toEqual([]);
  });

  // AJ. Scentic core git status remains unchanged by AGPL-01
  it('AJ: Scentic core git status has no AGPL-01-related entries and no nested AGPL repo', () => {
    const scentCoreDir = path.resolve(repoRoot, '..', 'scentic.ai');
    expect(existsSync(scentCoreDir)).toBe(true);

    // The AGPL repo must not be nested inside the Scentic core working tree.
    expect(existsSync(path.join(scentCoreDir, 'scentic-agpl-services'))).toBe(false);
    expect(existsSync(path.join(scentCoreDir, 'gateway'))).toBe(false);

    const status = execSync(`git -C "${scentCoreDir}" status --porcelain`, { encoding: 'utf-8' });
    const paths = porcelainPaths(status);

    // No Scentic-core path should reference the AGPL repo, its gateway, or vendor.
    const agplLeak = paths.filter(p =>
      /scentic-agpl-services/i.test(p) ||
      /agpl-services/i.test(p) ||
      /\bagpl\b/i.test(p) ||
      /\/gateway\//i.test(p) ||
      /\/vendor\/(kimai|opensign)/i.test(p),
    );

    expect(agplLeak).toEqual([]);
  });
});
