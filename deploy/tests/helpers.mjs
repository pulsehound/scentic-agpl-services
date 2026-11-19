// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared by the tests in this folder: where things are, and a copy of the vendored OpenSign server
// to patch. The vendored tree (vendor/opensign, fetched by scripts/update-vendor.sh, not committed)
// is never written to — every test patches a copy in a temporary folder.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = join(DEPLOY, '..');
export const VENDOR_SERVER = join(REPO, 'vendor', 'opensign', 'apps', 'OpenSignServer');
export const VENDOR_FRONTEND = join(REPO, 'vendor', 'opensign', 'apps', 'OpenSign');
export const SERVER_FILES = join(DEPLOY, 'opensign-server-files');

export const hasVendor = existsSync(join(VENDOR_SERVER, 'cloud', 'main.js'));
export const NO_VENDOR = 'vendor/opensign is not on disk (run scripts/update-vendor.sh); these tests patch the real upstream files and have nothing to run against';

/** Every .js file under a folder, as paths relative to it. */
export function jsFiles(root, under = '') {
  const out = [];
  for (const name of readdirSync(join(root, under))) {
    if (name === 'node_modules') continue;
    const rel = under ? `${under}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...jsFiles(root, rel));
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/**
 * A copy of the vendored server's own source (no node_modules) in a new temporary folder, with
 * line endings as they are in the image. A Windows checkout has CRLF; the image, and so every
 * edit's text, has LF.
 */
export function copyOfVendoredServer() {
  const root = mkdtempSync(join(tmpdir(), 'opensign-server-'));
  for (const entry of ['index.js', 'Utils.js', 'cloud', 'utils', 'font', 'images']) {
    if (existsSync(join(VENDOR_SERVER, entry))) cpSync(join(VENDOR_SERVER, entry), join(root, entry), { recursive: true });
  }
  for (const rel of jsFiles(root)) {
    const file = join(root, rel);
    const text = readFileSync(file, 'utf8');
    if (text.includes('\r\n')) writeFileSync(file, text.replace(/\r\n/g, '\n'));
  }
  return root;
}
