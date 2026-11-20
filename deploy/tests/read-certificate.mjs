// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Print what a certificate PDF says, page by page: `node read-certificate.mjs <file.pdf>...`.
// For reading back a certificate made somewhere this folder's tests do not reach — inside the
// server image (make-certificate.mjs), or on staging.
//
// `--expect <file>` before the PDFs also checks them: each line of the file must be in the text
// of every PDF named (a line starting `!` must not be), compared with all white space removed,
// and nothing may be drawn outside the page border. Exit status 1 when any check fails.
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const args = process.argv.slice(2);
let expected = null;
if (args[0] === '--expect') {
  expected = readFileSync(args[1], 'utf8').split(/\r?\n/).filter(line => line.trim());
  args.splice(0, 2);
}
const squeezed = text => text.replace(/\s+/g, '');
let failed = 0;

for (const file of args) {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(file)), disableFontFace: true, verbosity: 0 }).promise;
  console.log(`== ${file}: ${pdf.numPages} page(s)`);
  let whole = '';
  let outsideTotal = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [, , width, height] = page.view;
    const items = (await page.getTextContent()).items.filter(i => i.str.trim());
    const outside = items.filter(i => i.transform[4] < 15 || i.transform[4] + i.width > width - 15 || i.transform[5] < 15 || i.transform[5] > height - 15);
    const text = items.map(i => i.str).join(' ');
    whole += `${text}\n`;
    outsideTotal += outside.length;
    console.log(`-- page ${n}: ${items.length} items, ${outside.length} outside the border, lowest y ${Math.round(Math.min(...items.map(i => i.transform[5])))}`);
    console.log(expected || text.length <= 700 ? text : `${text.slice(0, 450)} […] ${text.slice(-220)}`);
  }
  await pdf.destroy();
  if (expected) {
    const have = squeezed(whole);
    for (const line of expected) {
      const absent = line.startsWith('!');
      const wanted = squeezed(absent ? line.slice(1) : line);
      const found = have.includes(wanted);
      const ok = absent ? !found : found;
      if (!ok) failed++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${absent ? 'absent ' : 'present'} | ${absent ? line.slice(1) : line}`);
    }
    if (outsideTotal > 0) failed++;
    console.log(`${outsideTotal === 0 ? 'ok  ' : 'FAIL'} ${outsideTotal} items outside the border`);
  }
}
if (expected) {
  console.log(failed === 0 ? 'every check passed' : `${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}
