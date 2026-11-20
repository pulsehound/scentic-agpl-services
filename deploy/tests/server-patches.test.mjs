// SPDX-License-Identifier: AGPL-3.0-or-later
//
// deploy/opensign-server-patches.mjs, run over the real upstream server source (vendor/opensign).
//
// The script fails an image build when an edit's text is not there. That says nothing until an
// image is built; here every edit is applied to a copy of the vendored files, so an upstream change
// that breaks one shows up in a test run. What is proven is that the edits apply and the files
// still parse — not that the patched server behaves as intended, which only a running one shows.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyServerPatches } from '../opensign-server-patches.mjs';
import { NO_VENDOR, SERVER_FILES, copyOfVendoredServer, hasVendor, jsFiles } from './helpers.mjs';

describe.skipIf(!hasVendor)(`server patches over the vendored upstream source${hasVendor ? '' : ` — SKIPPED: ${NO_VENDOR}`}`, () => {
  let root;
  let applied;
  let before;
  let certificateEdits;

  beforeAll(() => {
    root = copyOfVendoredServer();
    before = new Map(jsFiles(root).map(rel => [rel, readFileSync(join(root, rel), 'utf8')]));
    applied = applyServerPatches({ root, filesDir: SERVER_FILES }).applied;
    certificateEdits = applied.filter(a => a.file.endsWith('GenerateCertificate.js')).map(a => a.why);
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it('every edit applies, each to exactly one place', () => {
    expect(applied.length).toBeGreaterThan(30);
    const more = applied.filter(a => a.count !== 1);
    expect(more, 'an edit matched more than one place in its file').toEqual([]);
  });

  it('every file an edit names was changed, and no other file was touched', () => {
    const named = new Set(applied.map(a => a.file));
    const changed = new Set(jsFiles(root).filter(rel => before.get(rel) !== readFileSync(join(root, rel), 'utf8')));
    // Replacement files are new, so they are in `changed` only when upstream had them (it does).
    expect([...changed].sort()).toEqual([...named].sort());
  });

  it('every patched file still parses', () => {
    for (const rel of new Set(applied.map(a => a.file))) {
      // Syntax only (--check): these are ES modules whose imports are not installed here.
      expect(() => execFileSync(process.execPath, ['--check', join(root, rel)], { stdio: 'pipe' }), rel).not.toThrow();
    }
  });

  it('a second run fails loudly and changes nothing', () => {
    const afterFirst = new Map(jsFiles(root).map(rel => [rel, readFileSync(join(root, rel), 'utf8')]));
    expect(() => applyServerPatches({ root, filesDir: SERVER_FILES })).toThrow(/already patched|not found|upstream changed shape/);
    for (const [rel, text] of afterFirst) expect(readFileSync(join(root, rel), 'utf8'), rel).toBe(text);
  });

  it('every single edit is refused the second time — none can be applied twice', () => {
    // The run above stops at its first refusal. Asked to keep going, a second pass must refuse
    // every edit, each as already there, and write nothing.
    const fresh = copyOfVendoredServer();
    try {
      const first = applyServerPatches({ root: fresh, filesDir: SERVER_FILES });
      expect(first.refused).toEqual([]);
      const snapshot = new Map(jsFiles(fresh).map(rel => [rel, readFileSync(join(fresh, rel), 'utf8')]));
      const second = applyServerPatches({ root: fresh, filesDir: SERVER_FILES, keepGoing: true });
      expect(second.applied).toEqual([]);
      expect(second.refused).toHaveLength(first.applied.length);
      for (const message of second.refused) expect(message).toContain('already patched');
      for (const [rel, text] of snapshot) expect(readFileSync(join(fresh, rel), 'utf8'), rel).toBe(text);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('what the patches are for is in the patched source', () => {
    const read = rel => readFileSync(join(root, rel), 'utf8');
    // The master key is in no command line, and no command is printed.
    expect(read('index.js')).not.toMatch(/MASTER_KEY=\$\{/);
    // A signature is bound to the signed-in signer.
    expect(read('cloud/parsefunction/pdf/PDF.js')).toContain("'You are not asked to sign this document.'");
    // A refusal is mailed to nobody where Scentic delivers, and the check comes before the send.
    const decline = read('cloud/parsefunction/declinedocument.js');
    expect(decline.indexOf("includes('data-scentic-delivers')")).toBeGreaterThan(-1);
    expect(decline.indexOf("includes('data-scentic-delivers')")).toBeLessThan(decline.indexOf('await sendSystemMail('));
    // Accounts are made by the server only.
    expect(read('cloud/main.js')).toContain('Parse.Cloud.beforeSave(Parse.User');
    // No signer account is given its own address as a password.
    for (const rel of ['linkContactToDoc.js', 'savecontact.js', 'editContact.js', 'ContactBookAftersave.js']) {
      expect(read(`cloud/parsefunction/${rel}`), rel).not.toMatch(/_user\.set\('password', (email|Email)/);
    }
  });

  it("the completion mail — the one mail OpenSign copies to a document's SenderMail — is not sent where Scentic delivers, whatever the setting", () => {
    const pdf = readFileSync(join(root, 'cloud/parsefunction/pdf/PDF.js'), 'utf8');
    // Sent from one place only, and SenderMail is a recipient nowhere else in the server. (It is a
    // reply-to address and a variable in a mail's wording in ForwardDoc.js, createBatchDocs.js and
    // here: named in a mail to somebody else, never written to.)
    expect(pdf.split('sendCompletedMail({').length - 1).toBe(1);
    const asRecipient = /\b(bcc|cc|recipient|to|updatedBcc)\s*[:=][^\n]*SenderMail/i;
    const recipients = jsFiles(root).filter(rel => asRecipient.test(readFileSync(join(root, rel), 'utf8')));
    expect(recipients).toEqual(['cloud/parsefunction/pdf/PDF.js']);
    expect(pdf.match(new RegExp(asRecipient.source, 'gi'))).toHaveLength(1);
    // The patched condition itself, cut from the source and run: true means "don't send".
    const condition = /\n {2}if \((doc\.IsSendMail === false[^\n]*)\) \{\n {4}console\.log\("don't send mail"\);\n {2}\} else \{\n {4}sendCompletedMail\(/.exec(pdf);
    expect(condition, 'the check directly in front of sendCompletedMail').not.toBeNull();
    const held = (doc, setting) => new Function('doc', 'process', `return (${condition[1]});`)(doc, { env: setting === undefined ? {} : { SEND_COMPLETION_MAIL: setting } });
    const delivers = { SenderMail: 'dana@cohenlevi.example', RequestBody: '<div data-scentic-delivers="1"></div>' };
    const hosted = { SenderMail: 'dana@cohenlevi.example', RequestBody: '<p>Please sign {{signing_url}}</p>' };
    // Scentic delivers: held back with the setting on, off or absent.
    for (const setting of ['true', 'false', undefined]) expect(held(delivers, setting), String(setting)).toBe(true);
    // Otherwise as it was after round 75: sent only when the setting is on and the document allows it.
    expect(held(hosted, 'true')).toBe(false);
    expect(held(hosted, undefined)).toBe(true);
    expect(held({ ...hosted, IsSendMail: false }, 'true')).toBe(true);
    expect(held({ SenderMail: 'dana@cohenlevi.example' }, 'true')).toBe(false);
  });

  it("the certificate: the firm's name as Organization, and the documents of a request between the summary and the originator", () => {
    const certificate = readFileSync(join(root, 'cloud/parsefunction/pdf/GenerateCertificate.js'), 'utf8');
    // Organization is no longer read straight from the platform account's company.
    expect(certificate).not.toContain("const company = docDetails?.ExtUserPtr?.Company || '';");
    expect(certificate).toContain("const company = scenticOrganization(docDetails, docDetails?.ExtUserPtr?.Company || '', timesRomanFont, width - 30 - 110);");
    // The list is drawn once, after the summary's last line and before the originator's heading.
    const summaryEnd = certificate.indexOf("page.drawText('Signers :'");
    const related = certificate.indexOf('drawScenticRelatedDocuments({');
    const originator = certificate.indexOf("page.drawText('Document originator'");
    expect(summaryEnd).toBeGreaterThan(-1);
    expect(related).toBeGreaterThan(summaryEnd);
    expect(originator).toBeGreaterThan(related);
    expect(certificate.split('drawScenticRelatedDocuments({').length - 1).toBe(1);
    // What follows the list can move: nothing below it is fixed to the first page any more.
    expect(certificate).not.toMatch(/\bconst (page|originatorHeaderY|nameY|emailY|ipY) =/);
    expect(certificate).toContain('page = related.page;');
    // The originator's address is still read from the document's own field, which the gateway sets.
    expect(certificate).toContain("const OriginIp = docDetails?.OriginIp || '';");
    // The event history is still the last thing drawn.
    expect(certificate.indexOf('drawScenticEventHistory({')).toBeGreaterThan(originator);
    const applied = names => names.every(why => certificateEdits.includes(why));
    expect(certificate).not.toMatch(/const owner(Name|Email) = docDetails/);
    expect(applied(['certificate originator name and address', 'certificate organization', 'certificate page can move on', 'certificate originator can move down', 'certificate related documents'])).toBe(true);
  });
});

describe('server patches: the script itself', () => {
  it('importing it patches nothing, and a root without the files is refused', () => {
    expect(typeof applyServerPatches).toBe('function');
    expect(() => applyServerPatches({ root: join(SERVER_FILES, 'no-such-root'), filesDir: SERVER_FILES })).toThrow();
  });
});
