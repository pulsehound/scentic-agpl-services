/**
 * A small stand-in for OpenSign's Parse server, at the level of `fetch`.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The ceremony routes are about what is sent to OpenSign and as whom: which account's session, which
 * address in X-Forwarded-For, in what order relative to the read before them. A double of the
 * client's methods cannot show any of that — it replaces the code that does it. This one sits
 * below the real OpenSignClient and answers the handful of Parse routes the gateway uses, keeping
 * a document, its files and its sessions the way the patched server does (deploy/
 * opensign-server-patches.mjs): a signature or a refusal is accepted only from the signer's own
 * signed-in account, and the address written in the trail is the first X-Forwarded-For entry.
 *
 * Synthetic and in memory, made and thrown away by each test. It proves what the gateway sends,
 * not that a real OpenSign accepts it — that is the contract suite's and the staging run's to say.
 */

import { createHash } from 'node:crypto';

export interface FakeCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

interface FakeContact {
  objectId: string;
  Email: string;
  Name: string;
  UserId: { __type: 'Pointer'; className: '_User'; objectId: string };
}

export interface FakeParse {
  fetch: typeof fetch;
  calls: FakeCall[];
  /** The document as the server holds it (one per fake). */
  doc: () => Record<string, any>;
  /** The bytes behind the document's current file. */
  currentFile: () => Buffer;
  /** Every session token ever issued, for asserting none of them leaked. */
  tokens: () => string[];
  /** Most signPdf calls in flight at one moment. */
  maxConcurrentSigns: () => number;
  /** Make the next call to one cloud function fail with this status and body. */
  failNext: (fn: string, status: number, body: Record<string, unknown>) => void;
  /** How long signPdf takes: long enough for a second request to arrive meanwhile. */
  signDelayMs: number;
}

const BASE = 'http://localhost:8080/app';
const MASTER = 'test-master-key';

export function makeFakeParse(): FakeParse {
  const calls: FakeCall[] = [];
  const files = new Map<string, Buffer>();
  const sessions = new Map<string, string>();
  const contacts: FakeContact[] = [];
  const failures = new Map<string, { status: number; body: Record<string, unknown> }>();
  let doc: Record<string, any> | null = null;
  let fileCounter = 0;
  let sessionCounter = 0;
  let signing = 0;
  let maxSigning = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const self: FakeParse = {
    calls,
    doc: () => doc!,
    currentFile: () => files.get(doc!.SignedUrl || doc!.URL)!,
    tokens: () => [...sessions.keys()],
    maxConcurrentSigns: () => maxSigning,
    failNext: (fn, status, body) => { failures.set(fn, { status, body }); },
    signDelayMs: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      const body = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;

      // A stored file, by the short-lived address getsignedurl gave for it.
      if (!url.startsWith(BASE)) {
        const stored = url.replace(/\?sig=1$/, '');
        const bytes = files.get(stored);
        // A turn of the event loop, as a real fetch takes: two requests can interleave here.
        await new Promise((resolve) => setTimeout(resolve, 1));
        return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response('', { status: 404 });
      }

      const path = url.slice(BASE.length);
      calls.push({ method, path, headers, body });
      const master = headers['x-parse-master-key'] === MASTER;
      const sessionUser = sessions.get(headers['x-parse-session-token'] ?? '') ?? null;
      const firstForwarded = (headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();

      if (path === '/login') {
        sessions.set('admin-session', 'admin-user');
        return json(200, { sessionToken: 'admin-session', objectId: 'admin-user' });
      }
      if (path === '/loginAs') {
        if (!master) return json(403, { code: 119, error: 'master key is required' });
        const token = `r:session-${String(body?.userId)}-${++sessionCounter}`;
        sessions.set(token, String(body?.userId));
        return json(200, { sessionToken: token, objectId: body?.userId });
      }
      if (path.startsWith('/classes/contracts_Users')) return json(200, { results: [{ objectId: 'ext-admin' }] });
      if (path.startsWith('/classes/partners_Tenant')) return json(200, { objectId: 'tenant-1', TenantName: body?.TenantName, IsActive: true });
      if (path.startsWith('/classes/contracts_Contactbook/')) {
        const contact = contacts.find((c) => c.objectId === path.split('/').pop());
        return contact ? json(200, contact) : json(404, { code: 101, error: 'Object not found.' });
      }
      if (path.startsWith('/classes/contracts_Document/') && method === 'PUT') {
        if (!master || !doc) return json(403, { code: 119, error: 'forbidden' });
        for (const [key, value] of Object.entries(body ?? {})) {
          if (value && typeof value === 'object' && (value as any).__op === 'Delete') delete doc[key];
          else doc[key] = value;
        }
        return json(200, { updatedAt: new Date().toISOString() });
      }

      if (path.startsWith('/functions/')) {
        const fn = path.slice('/functions/'.length);
        const params = body ?? {};
        const failure = failures.get(fn);
        if (failure) {
          failures.delete(fn);
          return json(failure.status, failure.body);
        }

        switch (fn) {
          case 'savefile': {
            const stored = `http://files.test/original-${++fileCounter}.pdf`;
            files.set(stored, Buffer.from(String(params.fileBase64), 'base64'));
            return json(200, { result: { url: stored } });
          }
          case 'createdocumentfromapp': {
            const d = params.document as Record<string, any>;
            doc = {
              ...d,
              objectId: 'os-doc-1',
              IsCompleted: false,
              IsDeclined: false,
              IsArchive: false,
              Signers: [],
              AuditTrail: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            return json(200, { result: { objectId: 'os-doc-1' } });
          }
          case 'linkcontacttodoc': {
            const email = String(params.email);
            const n = contacts.length + 1;
            const contact: FakeContact = {
              objectId: `contact-${n}`,
              Email: email,
              Name: String(params.name ?? email),
              UserId: { __type: 'Pointer', className: '_User', objectId: `signer-user-${n}` },
            };
            contacts.push(contact);
            const placeholder = (doc!.Placeholders as any[]).find((p) => p.email === email);
            if (placeholder) placeholder.signerObjId = contact.objectId;
            doc!.Signers.push(contact);
            return json(200, { result: { contactId: contact.objectId } });
          }
          case 'sendmailv3':
            return json(200, { result: { status: 'success' } });
          case 'getDocument': {
            if (!master) return json(200, { result: { error: "You don't have access of this document!" } });
            if (!doc || doc.IsArchive) return json(200, { result: { error: "document deleted or you don't have access." } });
            return json(200, { result: JSON.parse(JSON.stringify(doc)) });
          }
          case 'getsignedurl':
            return json(200, { result: `${String(params.url)}?sig=1` });
          case 'triggerevent': {
            const user = sessions.get(headers['sessiontoken'] ?? '');
            if (!user) return json(200, { result: { message: 'User not found!' } });
            const contactId = String(params.contactId);
            const entry = { UserPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contactId }, SignedUrl: doc!.SignedUrl || '', Activity: 'Viewed', ipAddress: firstForwarded, ViewedOn: new Date().toISOString() };
            const at = (doc!.AuditTrail as any[]).findIndex((x) => x?.UserPtr?.objectId === contactId);
            // As upstream: the signer's whole entry is rewritten, whatever it said before.
            if (at === -1) doc!.AuditTrail.push(entry);
            else doc!.AuditTrail[at] = { ...doc!.AuditTrail[at], ...entry };
            return json(200, { result: { message: 'event called!' } });
          }
          case 'signPdf': {
            signing++;
            maxSigning = Math.max(maxSigning, signing);
            try {
              if (self.signDelayMs) await new Promise((resolve) => setTimeout(resolve, self.signDelayMs));
              if (!doc || doc.IsDeclined || doc.IsArchive) return json(400, { code: 101, error: 'Document not found.' });
              const contact = contacts.find((c) => c.objectId === params.userId);
              if (!sessionUser) return json(400, { code: 209, error: 'User is not authenticated.' });
              if (!contact || contact.UserId.objectId !== sessionUser) {
                return json(400, { code: 119, error: 'You are not asked to sign this document.' });
              }
              const bytes = Buffer.from(String(params.pdfFile), 'base64');
              const stored = `http://files.test/signed-${++fileCounter}.pdf`;
              files.set(stored, bytes);
              const entry = { UserPtr: { __type: 'Pointer', className: 'contracts_Contactbook', objectId: contact.objectId }, SignedUrl: stored, Activity: 'Signed', ipAddress: firstForwarded, SignedOn: new Date().toISOString(), Signature: params.signature };
              const at = (doc.AuditTrail as any[]).findIndex((x) => x?.UserPtr?.objectId === contact.objectId);
              if (at === -1) doc.AuditTrail.push(entry);
              else doc.AuditTrail[at] = { ...doc.AuditTrail[at], ...entry };
              doc.SignedUrl = stored;
              const signed = (doc.AuditTrail as any[]).filter((x) => x.Activity === 'Signed').length;
              if (signed >= (doc.Placeholders as any[]).length) {
                doc.IsCompleted = true;
                doc.DocumentHash = createHash('sha256').update(bytes).update('sealed').digest('hex');
              }
              return json(200, { result: { status: 'success', data: stored } });
            } finally {
              signing--;
            }
          }
          case 'declinedoc': {
            if (!doc || doc.IsCompleted || doc.IsArchive) return json(400, { code: 101, error: 'Object not found.' });
            if (!sessionUser) return json(400, { code: 209, error: 'User is not authenticated.' });
            if (sessionUser !== params.userId) return json(400, { code: 119, error: 'You are not asked to sign this document.' });
            doc.IsDeclined = true;
            doc.DeclineReason = params.reason;
            doc.DeclineBy = { __type: 'Pointer', className: '_User', objectId: params.userId };
            return json(200, { result: 'document declined' });
          }
          default:
            return json(404, { code: 141, error: `Invalid function: "${fn}"` });
        }
      }
      return json(404, { error: 'not found' });
    }) as typeof fetch,
  };
  return self;
}
