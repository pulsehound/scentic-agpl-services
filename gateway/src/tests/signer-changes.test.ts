/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Changing who signs after sending, taking a signature back, and Scentic sending the messages
 * itself. The rules are in signer-changes.ts; the service is checked against a fake OpenSign.
 */
import { describe, it, expect, vi } from 'vitest';
import { signerRows, withSignerReplaced, withSignatureRevoked, isChangeError } from '../opensign/signer-changes.js';
import { OpenSignService } from '../opensign/opensign-service.js';
import { SCENTIC_DELIVERS_MARKER, signingUrlFor } from '../opensign/opensign-client.js';
import type { OpenSignDocument } from '../opensign/types.js';

const ptr = (objectId: string) => ({ objectId, __type: 'Pointer', className: 'contracts_Contactbook' });

/** Buyer signed at 10:00, seller at 11:00, witness not yet — in a document still open. */
function doc(overrides: Partial<OpenSignDocument> = {}): OpenSignDocument {
  return {
    objectId: 'doc-1',
    Name: 'Agreement',
    URL: 'https://files/original.pdf',
    SignedUrl: 'https://files/after-seller.pdf',
    IsCompleted: false,
    IsDeclined: false,
    IsArchive: false,
    Signers: [ptr('c-buyer'), ptr('c-seller'), ptr('c-witness')],
    Placeholders: [
      { Role: 'signer', email: 'buyer@example.com', signerObjId: 'c-buyer', signerPtr: ptr('c-buyer') },
      { Role: 'signer', email: 'seller@example.com', signerObjId: 'c-seller', signerPtr: ptr('c-seller') },
      { Role: 'viewer', email: 'copy@example.com' },
      { Role: 'signer', email: 'witness@example.com', signerObjId: 'c-witness', signerPtr: ptr('c-witness') },
    ],
    AuditTrail: [
      { UserPtr: ptr('c-buyer'), Activity: 'Signed', ViewedOn: '2026-10-20T09:55:00Z', SignedOn: '2026-10-20T10:00:00Z', SignedUrl: 'https://files/after-buyer.pdf', ipAddress: '1.1.1.1', Signature: 'img' },
      { UserPtr: ptr('c-seller'), Activity: 'Signed', ViewedOn: '2026-10-20T10:50:00Z', SignedOn: '2026-10-20T11:00:00Z', SignedUrl: 'https://files/after-seller.pdf', ipAddress: '2.2.2.2' },
      { UserPtr: ptr('c-witness'), Activity: 'Viewed', ViewedOn: '2026-10-20T11:30:00Z' },
    ],
    createdAt: '2026-10-20T08:00:00Z',
    updatedAt: '2026-10-20T11:30:00Z',
    ...overrides,
  };
}

describe('signerRows', () => {
  it('lists the people asked to sign, in order, leaving out a copy recipient', () => {
    const rows = signerRows(doc());
    expect(rows.map((r) => [r.email, r.order, r.state])).toEqual([
      ['buyer@example.com', 1, 'signed'],
      ['seller@example.com', 2, 'signed'],
      ['witness@example.com', 3, 'viewed'],
    ]);
  });
});

describe('withSignerReplaced', () => {
  it('moves the place to the new address and drops the old contact, so the old link names nobody', () => {
    const next = withSignerReplaced(doc(), 'Witness@Example.com', 'deputy@example.com');
    if (isChangeError(next)) throw new Error(next.message);
    const placeholder = next.placeholders[3]!;
    expect(placeholder.email).toBe('deputy@example.com');
    expect(placeholder.signerObjId).toBeUndefined();
    expect(placeholder.signerPtr).toBeUndefined();
    expect(next.signers.map((s) => s.objectId)).toEqual(['c-buyer', 'c-seller']);
    expect(next.oldContactId).toBe('c-witness');
  });

  it('refuses to replace somebody whose signature is already on the document', () => {
    const next = withSignerReplaced(doc(), 'buyer@example.com', 'deputy@example.com');
    expect(isChangeError(next) && next.code).toBe('ALREADY_SIGNED');
  });

  it('refuses an address already on the document, and one that is not', () => {
    expect((withSignerReplaced(doc(), 'witness@example.com', 'seller@example.com') as { code: string }).code).toBe('ALREADY_ON_DOCUMENT');
    expect((withSignerReplaced(doc(), 'nobody@example.com', 'x@example.com') as { code: string }).code).toBe('NOT_A_SIGNER');
  });
});

describe('withSignatureRevoked', () => {
  it('taking back the latest signature returns the document to the one before it', () => {
    const next = withSignatureRevoked(doc(), 'seller@example.com');
    if (isChangeError(next)) throw new Error(next.message);
    expect(next.signedUrl).toBe('https://files/after-buyer.pdf');
    expect(next.clearedEmails).toEqual(['seller@example.com']);
    const seller = next.auditTrail[1]!;
    expect(seller).toEqual({ UserPtr: ptr('c-seller'), Activity: 'Viewed', ViewedOn: '2026-10-20T10:50:00Z', ipAddress: '2.2.2.2' });
    expect(next.auditTrail[0]!.Activity).toBe('Signed');
  });

  it('taking back an earlier signature clears every signature made after it, and the original stands', () => {
    const next = withSignatureRevoked(doc(), 'buyer@example.com');
    if (isChangeError(next)) throw new Error(next.message);
    expect(next.signedUrl).toBeNull();
    expect(next.clearedEmails.sort()).toEqual(['buyer@example.com', 'seller@example.com']);
    expect(next.auditTrail.filter((e) => e.Activity === 'Signed')).toEqual([]);
    // The signature image goes with the signature.
    expect(JSON.stringify(next.auditTrail)).not.toContain('"Signature"');
  });

  it('says so when there is nothing to take back', () => {
    expect((withSignatureRevoked(doc(), 'witness@example.com') as { code: string }).code).toBe('NOT_SIGNED');
  });
});

// ── The service, against a fake OpenSign ────────────────────────────────

function service(document: OpenSignDocument, overrides: Record<string, unknown> = {}) {
  const client = {
    getDocument: vi.fn(async () => ({ success: true, data: document })),
    updateDocument: vi.fn(async () => ({ success: true, data: true })),
    linkContactToDoc: vi.fn(async () => ({ success: true, data: { objectId: 'c-deputy' } })),
    sendSigningInvitation: vi.fn(async () => ({ success: true })),
    uploadFile: vi.fn(async () => ({ success: true, data: { url: 'https://files/up.pdf' } })),
    createDocument: vi.fn(async () => ({ success: true, data: { objectId: 'doc-1' } })),
    ...overrides,
  };
  const store = {
    getOpenSignWorkflowMapping: vi.fn(async () => ({ status: 'ACTIVE', opensignDocumentId: 'doc-1', opensignStatus: 'IN_PROGRESS' })),
    getOpenSignFirmMapping: vi.fn(async () => ({ status: 'ACTIVE', opensignTenantId: 't', opensignTenantName: 'Firm' })),
    getOpenSignUserMapping: vi.fn(async () => null),
    upsertOpenSignSignerMapping: vi.fn(async () => undefined),
    upsertOpenSignWorkflowMapping: vi.fn(async () => ({ status: 'ACTIVE' })),
  };
  const outbox = { publish: vi.fn(async () => undefined) };
  const svc = new OpenSignService(client as never, store as never, outbox as never, {
    enabled: true, pollIntervalSeconds: 60, completionTimeoutSeconds: 60, publicUrl: 'https://sign.example.com',
  });
  return { svc, client, outbox };
}

describe('OpenSignService signer changes', () => {
  it('lists links only for people who can still sign', async () => {
    const { svc } = service(doc());
    const result = await svc.listSigners('firm', 'wf');
    if (!result.success) throw new Error('failed');
    const byEmail = Object.fromEntries(result.data.signers.map((s) => [s.email, s.signingUrl]));
    expect(byEmail['buyer@example.com']).toBeUndefined();
    expect(byEmail['witness@example.com']).toBe(signingUrlFor('https://sign.example.com', 'doc-1', 'witness@example.com', 'c-witness'));
  });

  it('gives no link at all once the document is withdrawn', async () => {
    const { svc } = service(doc({ IsArchive: true }));
    const result = await svc.listSigners('firm', 'wf');
    if (!result.success) throw new Error('failed');
    expect(result.data.signers.every((s) => s.signingUrl === undefined)).toBe(true);
  });

  it('replaces a signer: saves the document, links the new address, returns the new link', async () => {
    const { svc, client } = service(doc());
    const result = await svc.replaceSigner('firm', 'wf', { fromEmail: 'witness@example.com', toEmail: 'Deputy@Example.com', toName: 'Dana Deputy' }, 'c1');
    if (!result.success) throw new Error(result.error.message);
    expect(client.updateDocument).toHaveBeenCalledTimes(1);
    expect(client.linkContactToDoc).toHaveBeenCalledWith({ docId: 'doc-1', email: 'deputy@example.com', name: 'Dana Deputy' });
    expect(result.data.signingUrl).toBe(signingUrlFor('https://sign.example.com', 'doc-1', 'deputy@example.com', 'c-deputy'));
  });

  it('puts the original signer back when the new one cannot be linked', async () => {
    const original = doc();
    const { svc, client } = service(original, { linkContactToDoc: vi.fn(async () => ({ success: false, error: { code: 'X', message: 'no' } })) });
    const result = await svc.replaceSigner('firm', 'wf', { fromEmail: 'witness@example.com', toEmail: 'deputy@example.com', toName: '' }, 'c1');
    expect(result.success).toBe(false);
    expect(client.updateDocument).toHaveBeenLastCalledWith('doc-1', { Placeholders: original.Placeholders, Signers: original.Signers });
  });

  it('refuses any change once everybody has signed', async () => {
    const { svc, client } = service(doc({ IsCompleted: true }));
    expect((await svc.replaceSigner('firm', 'wf', { fromEmail: 'witness@example.com', toEmail: 'd@example.com', toName: '' }, 'c')).success).toBe(false);
    expect((await svc.revokeSignature('firm', 'wf', 'seller@example.com', 'c')).success).toBe(false);
    expect(client.updateDocument).not.toHaveBeenCalled();
  });

  it('takes a signature back by writing the earlier PDF and the corrected trail', async () => {
    const { svc, client } = service(doc());
    const result = await svc.revokeSignature('firm', 'wf', 'seller@example.com', 'c');
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.clearedEmails).toEqual(['seller@example.com']);
    const [, fields] = client.updateDocument.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fields.SignedUrl).toBe('https://files/after-buyer.pdf');
  });
});

describe('Scentic delivering the messages', () => {
  const create = (svc: OpenSignService, scenticDelivers: boolean) =>
    svc.createWorkflow({
      scenticFirmId: 'firm', scenticSignatureWorkflowId: 'wf-new', scenticMatterId: '', scenticDocumentId: 'd',
      scenticDocumentVersionId: '', scenticPhysicalFileId: '', documentName: 'a.pdf', documentBase64: 'JVBERi0=',
      signers: [
        { scenticSignerId: 'a', email: 'a@example.com', name: 'A', role: 'signer', order: 1 },
        { scenticSignerId: 'b', email: 'b@example.com', name: 'B', role: 'signer', order: 2 },
      ],
      sendNow: true, sendInOrder: true, scenticDelivers,
    }, 'c');

  it('sends nothing, turns OpenSign reminders off, and leaves only the marker for the next signer', async () => {
    const { svc, client } = service(doc());
    const store = (svc as unknown as { store: { getOpenSignWorkflowMapping: ReturnType<typeof vi.fn> } }).store;
    store.getOpenSignWorkflowMapping.mockResolvedValueOnce(null);
    const result = await create(svc, true);
    expect(result.success).toBe(true);
    expect(client.sendSigningInvitation).not.toHaveBeenCalled();
    const params = (client.createDocument.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.automaticReminders).toBe(false);
    expect(String(params.requestBody)).toContain(SCENTIC_DELIVERS_MARKER);
  });

  it('still invites the first signer itself when Scentic does not deliver', async () => {
    const { svc, client } = service(doc());
    const store = (svc as unknown as { store: { getOpenSignWorkflowMapping: ReturnType<typeof vi.fn> } }).store;
    store.getOpenSignWorkflowMapping.mockResolvedValueOnce(null);
    await create(svc, false);
    expect(client.sendSigningInvitation).toHaveBeenCalledTimes(1);
    const params = (client.createDocument.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params.automaticReminders).toBe(true);
  });
});
