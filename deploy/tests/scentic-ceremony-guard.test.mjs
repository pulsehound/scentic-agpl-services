// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A document Scentic hosts the signing of (ScenticCeremony: true) answers the server's own calls
// only: OpenSign's page — a signer's session — cannot open, view, sign or decline it, and no code
// is mailed for it. Every other document behaves as it did.
//
// The functions run here are OpenSign's real ones from vendor/opensign after
// deploy/opensign-server-patches.mjs, and this repository's own SendMailOTPv1.js. What is stood in
// for: `Parse` (a small in-memory one, below) and everything each file imports (replaced by inert
// stand-ins that record their calls) — so what is proven is each function's own decisions, in
// order, not the server around them.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyServerPatches } from '../opensign-server-patches.mjs';
import { DEPLOY, NO_VENDOR, SERVER_FILES, copyOfVendoredServer, hasVendor } from './helpers.mjs';

const RUN = join(DEPLOY, 'tests', '.guard-run');
const FORBIDDEN = 119;
const OTHER_PAGE = /signed on another page/;

/** A module's source with every import but Node's own replaced by an inert stand-in of the same names. */
function withImportsStoodIn(source) {
  const prelude =
    'const __stand = name => { const f = async (...args) => { globalThis.__standInCalls.push([name, args]); return undefined; };\n' +
    "  return new Proxy(f, { get: (t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : k in t ? t[k] : __stand(`${name}.${String(k)}`)) }); };\n";
  const body = source.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (all, clause, from) => {
    if (from.startsWith('node:')) return all;
    const out = [];
    const named = /\{([\s\S]*)\}/.exec(clause);
    const first = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
    if (first) out.push(`const ${first} = __stand(${JSON.stringify(from)});`);
    for (const part of named ? named[1].split(',').map(s => s.trim()).filter(Boolean) : []) {
      const local = part.split(/\s+as\s+/).pop();
      out.push(`const ${local} = __stand(${JSON.stringify(`${from}#${local}`)});`);
    }
    return out.join(' ');
  });
  return prelude + body;
}

class FakeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
Object.assign(FakeError, { OPERATION_FORBIDDEN: 119, OBJECT_NOT_FOUND: 101, INVALID_SESSION_TOKEN: 209, SCRIPT_FAILED: 141, EMAIL_NOT_FOUND: 205 });

function fakeParse(store) {
  class Stored {
    constructor(className, data) { this.className = className; this.data = data; this.id = data.objectId; }
    get(key) {
      // Included pointers are objects of their own, as Parse hands them over.
      if (key === 'Signers') return (this.data.Signers || []).map(s => ({ id: s.objectId, get: k => (k === 'UserId' ? { id: s.UserId?.objectId } : s[k]) }));
      return this.data[key];
    }
    set(key, value) { this.data[key] = value; }
    unset(key) { delete this.data[key]; }
    increment(key) { this.data[key] = (this.data[key] || 0) + 1; }
    async save() { store.saves.push([this.className, this.id]); return this; }
    getACL() { return { getReadAccess: id => !!this.data.ACL?.[id]?.read }; }
    toJSON() { return JSON.parse(JSON.stringify(this.data)); }
  }
  class Query {
    constructor(className) { this.className = className; this.eq = {}; }
    include() { return this; }
    select() { return this; }
    notEqualTo() { return this; }
    equalTo(key, value) { this.eq[key] = value; return this; }
    async get(id) {
      const data = (store[this.className] || []).find(d => d.objectId === id);
      if (!data) throw new FakeError(101, 'Object not found.');
      return new Stored(this.className, data);
    }
    async first() {
      const data = (store[this.className] || []).find(d => Object.entries(this.eq).every(([k, v]) => d[k] === v));
      return data ? new Stored(this.className, data) : undefined;
    }
  }
  class Fresh {
    constructor(className) { this.className = className; this.fields = {}; }
    set(key, value) { this.fields[key] = value; }
    async save() {
      const data = (store[this.className] || []).find(d => d.objectId === this.id);
      if (data) Object.assign(data, this.fields);
      store.saves.push([this.className, this.id]);
      return this;
    }
  }
  Fresh.extend = className => class extends Fresh { constructor() { super(className); } };
  return { Error: FakeError, Query, Object: Fresh, User: 'User' };
}

const contact = (id, email, userId) => ({ objectId: id, Email: email, Name: 'Stored Name', UserId: { objectId: userId } });
function document(id, scentic) {
  return {
    objectId: id,
    Name: 'Engagement letter',
    IsEnableOTP: true,
    IsCompleted: false,
    IsDeclined: false,
    ...(scentic ? { ScenticCeremony: true, RequestBody: '<div data-scentic-delivers="1"></div>' } : {}),
    // On the ACL either way here: the question is what the functions do even when it is.
    ACL: { 'user-1': { read: true, write: true }, admin: { read: true, write: true } },
    CreatedBy: { objectId: 'admin' },
    ExtUserPtr: { objectId: 'ext-admin', Name: 'Firm', Email: 'firm@example.com', TenantId: { objectId: 't1' } },
    Signers: [contact('c1', 'signer@example.com', 'user-1')],
    Placeholders: [{ Role: 'signer', email: 'signer@example.com', signerObjId: 'c1', signerPtr: { objectId: 'c1', UserId: { objectId: 'user-1' } } }],
    AuditTrail: [],
  };
}

describe.skipIf(!hasVendor)(`a document Scentic hosts the signing of, and OpenSign's own functions${hasVendor ? '' : ` — SKIPPED: ${NO_VENDOR}`}`, () => {
  const fn = {};
  let store;
  const signer = { id: 'user-1', get: key => ({ email: 'signer@example.com' })[key] };

  beforeAll(async () => {
    rmSync(RUN, { recursive: true, force: true });
    mkdirSync(RUN, { recursive: true });
    const copy = copyOfVendoredServer();
    applyServerPatches({ root: copy, filesDir: SERVER_FILES });
    const sources = {
      signPdf: join(copy, 'cloud', 'parsefunction', 'pdf', 'PDF.js'),
      declinedoc: join(copy, 'cloud', 'parsefunction', 'declinedocument.js'),
      triggerevent: join(copy, 'cloud', 'parsefunction', 'triggerEvent.js'),
      getDocument: join(copy, 'cloud', 'parsefunction', 'getDocument.js'),
      // The patch script installs ours over upstream's: the patched copy holds this repository's file.
      sendOtp: join(copy, 'cloud', 'parsefunction', 'SendMailOTPv1.js'),
    };
    expect(readFileSync(sources.sendOtp, 'utf8')).toBe(readFileSync(join(SERVER_FILES, 'SendMailOTPv1.js'), 'utf8'));
    globalThis.__standInCalls = [];
    for (const [name, file] of Object.entries(sources)) {
      const out = join(RUN, `${name}.mjs`);
      writeFileSync(out, withImportsStoodIn(readFileSync(file, 'utf8')));
      fn[name] = (await import(pathToFileURL(out).href)).default;
      expect(typeof fn[name], name).toBe('function');
    }
    rmSync(copy, { recursive: true, force: true });
  });
  afterAll(() => {
    rmSync(RUN, { recursive: true, force: true });
    delete globalThis.Parse;
    delete globalThis.__standInCalls;
  });
  beforeEach(() => {
    store = { contracts_Document: [document('scentic-doc', true), document('hosted-doc', false)], defaultdata_Otp: [], saves: [] };
    globalThis.Parse = fakeParse(store);
    globalThis.__standInCalls.length = 0;
  });
  const doc = id => store.contracts_Document.find(d => d.objectId === id);
  const refusal = async promise => { try { await promise; return null; } catch (err) { return err; } };

  describe('signPdf', () => {
    const call = (docId, who) => fn.signPdf({ params: { docId, userId: 'c1' }, headers: {}, ...who });

    it("refuses the signer's own session on a scentic-ceremony document, before anything else", async () => {
      const err = await refusal(call('scentic-doc', { user: signer }));
      expect(err?.code).toBe(FORBIDDEN);
      expect(err.message).toMatch(OTHER_PAGE);
      expect(doc('scentic-doc').AuditTrail).toEqual([]);
    });

    it("takes the server's own call for the signer it names: past every check, to the PDF it was not given", async () => {
      const err = await refusal(call('scentic-doc', { master: true }));
      expect(err?.message).toBe('Pdf file not present!');
    });

    it('a hosted document is as it was: the signer by their session, nobody without one, nobody else', async () => {
      expect((await refusal(call('hosted-doc', { user: signer })))?.message).toBe('Pdf file not present!');
      expect((await refusal(call('hosted-doc', {})))?.code).toBe(209);
      const other = await refusal(call('hosted-doc', { user: { id: 'user-9' } }));
      expect(other?.code).toBe(FORBIDDEN);
      expect(other.message).not.toMatch(OTHER_PAGE);
    });
  });

  describe('declinedoc', () => {
    const call = (docId, who) => fn.declinedoc({ params: { docId, userId: 'user-1', reason: 'No.' }, headers: {}, ...who });

    it("refuses the signer's own session on a scentic-ceremony document, and nothing is declined", async () => {
      const err = await refusal(call('scentic-doc', { user: signer }));
      expect(err?.code).toBe(FORBIDDEN);
      expect(err.message).toMatch(OTHER_PAGE);
      expect(doc('scentic-doc').IsDeclined).toBe(false);
      expect(store.saves).toEqual([]);
    });

    it("takes the server's own call, records who declined, and mails nobody (Scentic delivers)", async () => {
      expect(await call('scentic-doc', { master: true })).toBe('document declined');
      expect(doc('scentic-doc')).toMatchObject({ IsDeclined: true, DeclineReason: 'No.', DeclineBy: { objectId: 'user-1' } });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(globalThis.__standInCalls.filter(([name]) => name.includes('sendSystemMail'))).toEqual([]);
    });

    it('a hosted document is as it was: declined by the signer through their session, and the sender is mailed', async () => {
      expect(await call('hosted-doc', { user: signer })).toBe('document declined');
      expect(doc('hosted-doc').IsDeclined).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(globalThis.__standInCalls.filter(([name]) => name.includes('sendSystemMail'))).toHaveLength(1);
      expect((await refusal(call('hosted-doc', {})))?.code).toBe(209);
    });
  });

  describe('triggerevent (viewed)', () => {
    const call = (docId, who) => fn.triggerevent({ params: { event: 'viewed', contactId: 'c1', body: { objectId: docId } }, headers: { 'x-real-ip': '203.0.113.7', ...(who.sessiontoken ? { sessiontoken: who.sessiontoken } : {}) }, ...who });

    it('records nothing for a session on a scentic-ceremony document', async () => {
      expect(await call('scentic-doc', { sessiontoken: 'r:any-session', user: signer })).toEqual({ message: 'User not found!' });
      expect(doc('scentic-doc').AuditTrail).toEqual([]);
      // The session was not even looked up.
      expect(globalThis.__standInCalls.filter(([name]) => name.startsWith('axios'))).toEqual([]);
    });

    it("records the view for the server's own call, with the address it was given", async () => {
      expect(await call('scentic-doc', { master: true })).toEqual({ message: 'event called!' });
      expect(doc('scentic-doc').AuditTrail).toEqual([expect.objectContaining({ Activity: 'Viewed', ipAddress: '203.0.113.7', UserPtr: expect.objectContaining({ objectId: 'c1' }) })]);
    });

    it('a hosted document with codes on still wants a session', async () => {
      expect(await call('hosted-doc', {})).toEqual({ message: 'User not found!' });
      expect(doc('hosted-doc').AuditTrail).toEqual([]);
    });
  });

  describe('getDocument', () => {
    it('gives a scentic-ceremony document to the server only, whoever is on its ACL', async () => {
      expect(await fn.getDocument({ params: { docId: 'scentic-doc' }, headers: { sessiontoken: 'r:any-session' }, user: signer })).toEqual({ error: "You don't have access of this document!" });
      expect(globalThis.__standInCalls.filter(([name]) => name.startsWith('axios'))).toEqual([]);
      expect(await fn.getDocument({ params: { docId: 'scentic-doc' }, headers: {}, master: true })).toMatchObject({ objectId: 'scentic-doc', ScenticCeremony: true });
    });

    it('a hosted document is as it was: the server by the master key, anyone else by a session that is looked up', async () => {
      expect(await fn.getDocument({ params: { docId: 'hosted-doc' }, headers: {}, master: true })).toMatchObject({ objectId: 'hosted-doc' });
      await fn.getDocument({ params: { docId: 'hosted-doc' }, headers: { sessiontoken: 'r:any-session' } });
      expect(globalThis.__standInCalls.filter(([name]) => name.startsWith('axios'))).toHaveLength(1);
    });
  });

  describe('the code mail (SendMailOTPv1)', () => {
    const call = docId => fn.sendOtp({ params: { email: 'signer@example.com', docId }, headers: {} });

    it('is not sent for a scentic-ceremony document, to a signer on it or anyone', async () => {
      const err = await refusal(call('scentic-doc'));
      expect(err?.code).toBe(FORBIDDEN);
      expect(err.message).toMatch(OTHER_PAGE);
      expect(store.saves).toEqual([]);
      expect(globalThis.__standInCalls).toEqual([]);
    });

    it('for a hosted document it goes on to make a code, as before', async () => {
      const err = await refusal(call('hosted-doc'));
      // Whatever the stand-in mail sender then does, it is not this refusal: a code was made and stored.
      expect(err?.message ?? '').not.toMatch(OTHER_PAGE);
      expect(store.saves.some(([className]) => className === 'defaultdata_Otp')).toBe(true);
    });
  });
});
