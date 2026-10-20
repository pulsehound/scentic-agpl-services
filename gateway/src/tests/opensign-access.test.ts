/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Who can open a document on the signing engine. OpenSign hands a document to anyone holding its
 * id unless email codes are on, and the id is in every signing link; with codes on, the document's
 * ACL decides. These check what the real client sends, against a fake Parse server.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSignClient } from '../opensign/opensign-client.js';

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

/** A Parse server answering by path; every request is recorded. */
function fakeParse(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace(/^\/app/, '');
    const method = init.method ?? 'GET';
    calls.push({ url: path, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => `${method} ${path}`.startsWith(k));
    return new Response(JSON.stringify(key ? routes[key] : {}), { status: 200 });
  }));
  return calls;
}

const client = () =>
  new OpenSignClient({ baseUrl: 'https://engine.example/app', appId: 'opensign', masterKey: 'mk', adminEmail: 'admin@example.com', adminPassword: 'pw' });

const LOGIN = { 'POST /login': { sessionToken: 'r:admin', objectId: 'u-admin' }, 'GET /classes/contracts_Users': { results: [{ objectId: 'x-admin' }] } };

afterEach(() => vi.unstubAllGlobals());

describe('creating a document', () => {
  it('turns email codes on and names the firm, unless told otherwise', async () => {
    const calls = fakeParse({ ...LOGIN, 'POST /functions/createdocumentfromapp': { result: { objectId: 'doc-1' } } });
    await client().createDocument({
      name: 'Agreement', url: 'https://files/a.pdf', extUserPtr: { objectId: 'x-admin', __type: 'Pointer', className: 'contracts_Users' },
      signers: [], placeholders: [], firmName: 'Cohen & Co',
    });
    const created = calls.find((c) => c.url === '/functions/createdocumentfromapp')!;
    expect((created.body!.document as Record<string, unknown>).IsEnableOTP).toBe(true);
    const fields = calls.find((c) => c.method === 'PUT' && c.url === '/classes/contracts_Document/doc-1')!;
    expect(fields.body).toMatchObject({ FirmName: 'Cohen & Co', ACL: { 'u-admin': { read: true, write: true } } });
  });
});

describe('documentAccessWithout', () => {
  it('drops the account behind the contact and keeps everyone else', async () => {
    fakeParse({
      ...LOGIN,
      'GET /classes/contracts_Document/doc-1': { objectId: 'doc-1', ACL: { 'u-admin': { read: true, write: true }, 'u-old': { read: true, write: true }, 'u-other': { read: true, write: true } } },
      'GET /classes/contracts_Contactbook/c-old': { objectId: 'c-old', UserId: { __type: 'Pointer', className: '_User', objectId: 'u-old' } },
    });
    const result = await client().documentAccessWithout('doc-1', 'c-old');
    if (!result.success) throw new Error(result.error!.message);
    expect(Object.keys(result.data!.after).sort()).toEqual(['u-admin', 'u-other']);
    expect(Object.keys(result.data!.before).sort()).toEqual(['u-admin', 'u-old', 'u-other']);
  });

  it('never takes the platform account off a document', async () => {
    fakeParse({
      ...LOGIN,
      'GET /classes/contracts_Document/doc-1': { objectId: 'doc-1', ACL: { 'u-admin': { read: true, write: true } } },
      'GET /classes/contracts_Contactbook/c-admin': { objectId: 'c-admin', UserId: { __type: 'Pointer', className: '_User', objectId: 'u-admin' } },
    });
    const result = await client().documentAccessWithout('doc-1', 'c-admin');
    expect(result.data!.after).toEqual({ 'u-admin': { read: true, write: true } });
  });

  it('fails rather than guess when the contact cannot be read', async () => {
    const calls = fakeParse({ ...LOGIN, 'GET /classes/contracts_Document/doc-1': { objectId: 'doc-1', ACL: {} } });
    vi.mocked(fetch).mockImplementation(async (url) => {
      const path = new URL(String(url)).pathname.replace(/^\/app/, '');
      calls.push({ url: path, method: 'GET', body: undefined });
      if (path.startsWith('/classes/contracts_Contactbook')) return new Response('{}', { status: 404 });
      if (path === '/login') return new Response(JSON.stringify(LOGIN['POST /login']), { status: 200 });
      return new Response(JSON.stringify({ results: [], objectId: 'doc-1', ACL: {} }), { status: 200 });
    });
    expect((await client().documentAccessWithout('doc-1', 'c-gone')).success).toBe(false);
  });
});
