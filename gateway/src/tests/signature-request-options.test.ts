/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * What a sender chooses about a request — its wording, its order, how long signers have, where
 * they land afterwards — reaching OpenSign, and the executed document coming back as bytes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeApp, makeMockOpenSignClient, type TestApp } from './helpers.js';
import { signingMail } from '../opensign/opensign-client.js';
import { clampDays, httpsUrlOrEmpty, SIGNATURE_CAPABILITIES } from '../routes/signature.js';
import { parseDate, deriveDocumentStatus } from '../opensign/types.js';

const FIRM = 'firm-options-1';

const request = (over: Record<string, unknown> = {}) => ({
  scenticFirmId: FIRM,
  scenticSignatureWorkflowId: 'wf-options',
  scenticMatterId: 'matter-1',
  scenticDocumentId: 'doc-1',
  scenticDocumentVersionId: 'v-1',
  scenticPhysicalFileId: 'pf-1',
  documentName: 'SCT-00000242 – 10000007 – TAT – Agreement – v.001.pdf',
  documentTitle: 'Share Purchase Agreement',
  documentBase64: 'dGVzdA==',
  signers: [
    { scenticSignerId: 'b', email: 'second@example.com', name: 'Second', role: 'signer', order: 2 },
    { scenticSignerId: 'a', email: 'first@example.com', name: 'First', role: 'signer', order: 1 },
  ],
  sendNow: true,
  senderName: 'Udi Law Offices',
  ...over,
});

describe('request options', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = makeApp({ opensignClient: makeMockOpenSignClient() });
    await t.opensignService!.initFirm({ scenticFirmId: FIRM, firmName: 'Udi Law Offices' }, 'corr');
  });

  it("names the document by its title, not the stored file's name", async () => {
    await t.opensignService!.createWorkflow(request(), 'corr');
    const created = t.opensignClient!.createDocument.mock.calls[0][0] as { name: string };
    expect(created.name).toBe('Share Purchase Agreement');
    const invited = t.opensignClient!.sendSigningInvitation.mock.calls[0][0] as { documentName: string };
    expect(invited.documentName).toBe('Share Purchase Agreement');
  });

  it('invites everybody at once by default', async () => {
    await t.opensignService!.createWorkflow(request(), 'corr');
    expect(t.opensignClient!.sendSigningInvitation).toHaveBeenCalledTimes(2);
    const created = t.opensignClient!.createDocument.mock.calls[0][0] as { sendinOrder: boolean };
    expect(created.sendinOrder).toBe(false);
  });

  it('in order, invites only the first signer and leaves the rest to OpenSign', async () => {
    await t.opensignService!.createWorkflow(request({ sendInOrder: true }), 'corr');
    expect(t.opensignClient!.sendSigningInvitation).toHaveBeenCalledTimes(1);
    const invited = t.opensignClient!.sendSigningInvitation.mock.calls[0][0] as { recipientEmail: string };
    // Sorted by order, not by the order they arrived in.
    expect(invited.recipientEmail).toBe('first@example.com');

    const created = t.opensignClient!.createDocument.mock.calls[0][0] as {
      sendinOrder: boolean;
      placeholders: Array<{ email: string }>;
      requestBody: string;
      requestSubject: string;
    };
    expect(created.sendinOrder).toBe(true);
    expect(created.placeholders.map((p) => p.email)).toEqual(['first@example.com', 'second@example.com']);
    // OpenSign writes the next signer's mail from these, in its own variable syntax.
    expect(created.requestBody).toContain('{{signing_url}}');
    expect(created.requestBody).toContain('Hello,');
    expect(created.requestSubject).toBe('Please sign: Share Purchase Agreement');
  });

  it("carries the sender's subject, note, expiry and landing page", async () => {
    await t.opensignService!.createWorkflow(
      request({
        emailSubject: 'Please sign the SPA',
        emailMessage: 'Two signature pages.',
        expiresInDays: 7,
        redirectUrl: 'https://app.scentic.com/sign/done',
      }),
      'corr',
    );
    const created = t.opensignClient!.createDocument.mock.calls[0][0] as {
      timeToCompleteDays: number;
      redirectUrl: string;
    };
    expect(created.timeToCompleteDays).toBe(7);
    expect(created.redirectUrl).toBe('https://app.scentic.com/sign/done');
    const invited = t.opensignClient!.sendSigningInvitation.mock.calls[0][0] as {
      subject: string;
      message: string;
      expiresAt: string;
    };
    expect(invited.subject).toBe('Please sign the SPA');
    expect(invited.message).toBe('Two signature pages.');
    expect(invited.expiresAt).toMatch(/\d{4}$/);
  });

  it('leaves viewers out of the signing, so they neither get a sign request nor hold up completion', async () => {
    await t.opensignService!.createWorkflow(
      request({
        signers: [
          { scenticSignerId: 'a', email: 'first@example.com', name: 'First', role: 'signer', order: 1 },
          { scenticSignerId: 'v', email: 'copy@example.com', name: 'Copy', role: 'viewer', order: 1 },
        ],
      }),
      'corr',
    );
    const created = t.opensignClient!.createDocument.mock.calls[0][0] as { placeholders: Array<{ email: string }> };
    expect(created.placeholders.map((p) => p.email)).toEqual(['first@example.com']);
    expect(t.opensignClient!.sendSigningInvitation).toHaveBeenCalledTimes(1);
    expect(t.opensignClient!.linkContactToDoc).toHaveBeenCalledTimes(1);
  });

  it('refuses a request with only viewers', async () => {
    const result = await t.opensignService!.createWorkflow(
      request({ signers: [{ scenticSignerId: 'v', email: 'copy@example.com', name: 'Copy', role: 'viewer', order: 1 }] }),
      'corr',
    );
    expect(result.success).toBe(false);
  });

  it('hands over the signed PDF as bytes once everybody has signed', async () => {
    const pdf = Buffer.from('%PDF-1.7 signed');
    t.opensignClient!.getDocument.mockResolvedValueOnce({
      success: true,
      data: { objectId: 'doc-new', IsCompleted: true, SignedUrl: 'https://os/app/files/x/signed.pdf', Placeholders: [], AuditTrail: [] },
    } as never);
    (t.opensignClient as unknown as { fetchDocumentFile: unknown }).fetchDocumentFile = vi.fn(async () => ({ success: true, data: pdf }));

    await t.opensignService!.createWorkflow(request(), 'corr');
    const file = await t.opensignService!.getCompletedFile(FIRM, 'wf-options', 'signed');
    expect(file.success).toBe(true);
    if (file.success) {
      expect(file.data.bytes.equals(pdf)).toBe(true);
      expect(file.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('refuses the signed PDF while somebody has still to sign', async () => {
    await t.opensignService!.createWorkflow(request(), 'corr');
    const file = await t.opensignService!.getCompletedFile(FIRM, 'wf-options', 'signed');
    expect(file.success).toBe(false);
  });

  it('refuses another firm the signed PDF', async () => {
    await t.opensignService!.createWorkflow(request(), 'corr');
    const file = await t.opensignService!.getCompletedFile('firm-other', 'wf-options', 'signed');
    expect(file.success).toBe(false);
    if (!file.success) expect(file.error.code).toBe('NOT_FOUND');
  });
});

describe('signingMail', () => {
  const base = {
    senderName: 'Udi Law Offices',
    documentName: 'SPA <draft>',
    recipientName: 'Dana',
    link: 'https://sign.example/login/abc',
  };

  it("uses the sender's subject when there is one", () => {
    expect(signingMail({ ...base, kind: 'invitation', subject: 'Please sign' }).subject).toBe('Please sign');
    expect(signingMail({ ...base, kind: 'invitation' }).subject).toBe('Please sign: SPA <draft>');
  });

  it('greets plainly when the name is not known', () => {
    expect(signingMail({ ...base, recipientName: '', kind: 'invitation' }).html).toContain('>Hello,<');
  });

  it('says a reminder is one', () => {
    expect(signingMail({ ...base, kind: 'reminder' }).subject).toMatch(/^Reminder: /);
  });

  it('escapes what the sender and the document name contain', () => {
    const { html } = signingMail({ ...base, kind: 'invitation', message: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('SPA &lt;draft&gt;');
  });

  it("carries no third party's name", () => {
    expect(signingMail({ ...base, kind: 'invitation' }).html).not.toMatch(/opensign/i);
  });
});

describe('route helpers', () => {
  it('keeps expiry between a day and a year', () => {
    expect(clampDays(0)).toBeUndefined();
    expect(clampDays('x')).toBeUndefined();
    expect(clampDays(7)).toBe(7);
    expect(clampDays(5000)).toBe(365);
  });

  it('redirects a signer only to an https address', () => {
    expect(httpsUrlOrEmpty('https://app.scentic.com/x')).toBe('https://app.scentic.com/x');
    expect(httpsUrlOrEmpty('javascript:alert(1)')).toBe('');
    expect(httpsUrlOrEmpty('http://plain.example')).toBe('');
  });

  it('states what is unsupported rather than leaving it out', () => {
    expect(SIGNATURE_CAPABILITIES.delegate).toBe('unsupported');
  });
});

describe('Parse dates', () => {
  it('reads the {__type, iso} form a document comes back with', () => {
    expect(parseDate({ __type: 'Date', iso: '2026-10-23T10:00:00.000Z' })?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    expect(parseDate('2026-10-23T10:00:00.000Z')?.toISOString()).toBe('2026-10-23T10:00:00.000Z');
    expect(parseDate({ __type: 'Date' })).toBeNull();
    expect(parseDate('nonsense')).toBeNull();
  });

  it('sees a lapsed request as expired', () => {
    const doc = { IsCompleted: false, IsDeclined: false, IsArchive: false, ExpiryDate: { __type: 'Date', iso: '2020-01-01T00:00:00.000Z' } };
    expect(deriveDocumentStatus(doc)).toBe('EXPIRED');
  });

  it('reports the expiry in a status without throwing', async () => {
    const t = makeApp({ opensignClient: makeMockOpenSignClient() });
    await t.opensignService!.initFirm({ scenticFirmId: FIRM, firmName: 'Udi' }, 'corr');
    await t.opensignService!.createWorkflow(request(), 'corr');
    t.opensignClient!.getDocument.mockResolvedValueOnce({
      success: true,
      data: { objectId: 'doc-new', IsCompleted: false, IsDeclined: false, IsArchive: false, ExpiryDate: { __type: 'Date', iso: '2099-10-23T10:00:00.000Z' }, Placeholders: [], AuditTrail: [] },
    } as never);
    const status = await t.opensignService!.getWorkflowStatus(FIRM, 'wf-options', 'corr');
    expect(status.success && status.data.expiresAt).toBe('2099-10-23T10:00:00.000Z');
  });
});
