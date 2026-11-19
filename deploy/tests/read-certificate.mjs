// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Print what a certificate PDF says, page by page: `node read-certificate.mjs <file.pdf>...`.
// For reading back a certificate made somewhere this folder's tests do not reach — inside the
// server image, or on staging.
import { readFileSync } from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

for (const file of process.argv.slice(2)) {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(file)), disableFontFace: true, verbosity: 0 }).promise;
  console.log(`== ${file}: ${pdf.numPages} page(s)`);
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [, , width, height] = page.view;
    const items = (await page.getTextContent()).items.filter(i => i.str.trim());
    const outside = items.filter(i => i.transform[4] < 15 || i.transform[4] + i.width > width - 15 || i.transform[5] < 15 || i.transform[5] > height - 15);
    const text = items.map(i => i.str).join(' ');
    console.log(`-- page ${n}: ${items.length} items, ${outside.length} outside the border, lowest y ${Math.round(Math.min(...items.map(i => i.transform[5])))}`);
    console.log(text.length > 700 ? `${text.slice(0, 450)} […] ${text.slice(-220)}` : text);
  }
  await pdf.destroy();
}
