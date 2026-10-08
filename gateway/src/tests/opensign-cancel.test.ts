/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Withdrawing a document. It was done with declinedoc and no user, which built a pointer to an
 * empty id; every cancellation failed upstream and nothing could be withdrawn.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenSignClient } from '../opensign/opensign-client.js';

const client = () =>
  new OpenSignClient({ baseUrl: 'http://opensign.test/app', appId: 'app', masterKey: 'mk', adminEmail: 'a@x', adminPassword: 'p' });

afterEach(() => vi.unstubAllGlobals());

describe('cancelDocument', () => {
  it('archives the document with the master key and keeps the reason', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ updatedAt: 'now' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await client().cancelDocument('doc-1', '', 'Sent to the wrong party');
    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://opensign.test/app/classes/contracts_Document/doc-1');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ IsArchive: true, DeclineReason: 'Sent to the wrong party' });
    expect((init.headers as Record<string, string>)['X-Parse-Master-Key']).toBe('mk');
  });

  it('reports a refusal rather than pretending it worked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    expect((await client().cancelDocument('doc-1', '', 'x')).success).toBe(false);
  });
});
