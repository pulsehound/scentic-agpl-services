/**
 * Signature routes — OpenSign e-signature workflow endpoints.
 * All routes are Firm-scoped and require HMAC auth.
 */

import { Router } from 'express';
import type { OpenSignService } from '../opensign/opensign-service.js';
import { invalidInput } from '../http/errors.js';
import { getContext } from '../http/request-context.js';

export function createSignatureRouter(service: OpenSignService): Router {
  const router = Router();

  // OpenSign provider health
  router.get('/api/v1/providers/opensign/health', async (_req, res, next) => {
    try {
      const result = await service.checkHealth();
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // What the signing service does, in the provider-neutral vocabulary Scentic's settings read.
  // Static: these are properties of this integration, not of a firm or a moment.
  router.get('/api/v1/providers/capabilities', (_req, res) => {
    res.json({ ok: true, data: SIGNATURE_CAPABILITIES });
  });

  // Init firm for OpenSign
  router.post('/api/v1/firms/:firmId/signature/init', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      if (!b.firmName) {
        return next(invalidInput('firmName is required'));
      }
      const result = await service.initFirm({
        scenticFirmId: req.params.firmId,
        firmName: b.firmName,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Sync user for OpenSign
  router.post('/api/v1/firms/:firmId/signature/users/sync', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      if (!b.scenticUserId || !b.email || !b.name) {
        return next(invalidInput('scenticUserId, email, and name are required'));
      }
      const result = await service.syncUser({
        scenticFirmId: req.params.firmId,
        scenticUserId: b.scenticUserId,
        email: b.email,
        name: b.name,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Create workflow
  router.post('/api/v1/firms/:firmId/signature/workflows', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      if (!b.scenticSignatureWorkflowId || !b.scenticDocumentId || !b.documentName || !b.documentBase64) {
        return next(invalidInput('scenticSignatureWorkflowId, scenticDocumentId, documentName, and documentBase64 are required'));
      }
      // Named, it must be one of the two: a misspelt ceremony must not quietly become the other.
      if (b.ceremony !== undefined && b.ceremony !== 'hosted' && b.ceremony !== 'scentic') {
        return next(invalidInput('Invalid request', [{ field: 'ceremony', issue: "must be 'hosted' or 'scentic'" }]));
      }
      const result = await service.createWorkflow({
        scenticFirmId: req.params.firmId,
        scenticSignatureWorkflowId: b.scenticSignatureWorkflowId,
        scenticMatterId: b.scenticMatterId ?? '',
        scenticDocumentId: b.scenticDocumentId,
        scenticDocumentVersionId: b.scenticDocumentVersionId ?? '',
        scenticPhysicalFileId: b.scenticPhysicalFileId ?? '',
        documentName: b.documentName,
        documentBase64: b.documentBase64,
        signers: normaliseSigners(b.signers),
        sendNow: b.sendNow ?? true,
        senderName: typeof b.senderName === 'string' ? b.senderName : '',
        fields: Array.isArray(b.fields) ? b.fields : [],
        emailSubject: typeof b.emailSubject === 'string' ? b.emailSubject : '',
        emailMessage: typeof b.emailMessage === 'string' ? b.emailMessage : '',
        documentTitle: typeof b.documentTitle === 'string' ? b.documentTitle : '',
        expiresInDays: clampDays(b.expiresInDays),
        sendInOrder: b.sendInOrder === true,
        redirectUrl: httpsUrlOrEmpty(b.redirectUrl),
        dateFormat: typeof b.dateFormat === 'string' ? b.dateFormat : '',
        scenticDelivers: b.scenticDelivers === true,
        ceremony: b.ceremony === 'scentic' ? 'scentic' : 'hosted',
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Get workflow status
  router.get('/api/v1/firms/:firmId/signature/workflows/:workflowId', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.getWorkflowStatus(
        req.params.firmId,
        req.params.workflowId,
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Send workflow
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/send', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.sendWorkflow(
        req.params.firmId,
        req.params.workflowId,
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Cancel workflow
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/cancel', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      const result = await service.cancelWorkflow(
        req.params.firmId,
        req.params.workflowId,
        b.reason ?? 'cancelled_by_scentic',
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Remind signers
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/remind', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      const result = await service.sendReminder(
        req.params.firmId,
        req.params.workflowId,
        // Addresses, not internal ids. The caller knows who it wants chased by
        // the address it sent the invitation to; it has no visibility of
        // OpenSign's object ids and never should.
        b.signerEmails ?? b.scenticSignerIds ?? [],
        b.senderName ?? '',
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Everyone asked to sign, in order, with where they have got to and their personal link while it
  // can still be used — for Scentic to send the messages itself.
  router.get('/api/v1/firms/:firmId/signature/workflows/:workflowId/signers', async (req, res, next) => {
    try {
      const result = await service.listSigners(req.params.firmId, req.params.workflowId);
      if (!result.success) return next(result.error);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Somebody else signs in place of a signer who has not signed yet. The old link stops working.
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/signers/replace', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      const result = await service.replaceSigner(req.params.firmId, req.params.workflowId, {
        fromEmail: typeof b.fromEmail === 'string' ? b.fromEmail : '',
        toEmail: typeof b.toEmail === 'string' ? b.toEmail : '',
        toName: typeof b.toName === 'string' ? b.toName : '',
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Take a signature back before the document is complete, with any made after it.
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/signers/revoke', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      const result = await service.revokeSignature(
        req.params.firmId,
        req.params.workflowId,
        typeof b.email === 'string' ? b.email : '',
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Poll single workflow
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/poll', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.pollWorkflow(
        req.params.firmId,
        req.params.workflowId,
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Get completed PDF status
  router.get('/api/v1/firms/:firmId/signature/workflows/:workflowId/completed', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.getCompletedStatus(
        req.params.firmId,
        req.params.workflowId,
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // The executed PDF, or its certificate of completion, as bytes.
  //
  // Streamed rather than linked. The signing service's file links are signed for minutes and point
  // at a host Scentic has no reason to trust with a client document's address; Scentic files these
  // into the firm's own Drive and needs the bytes, not a pointer.
  router.get('/api/v1/firms/:firmId/signature/workflows/:workflowId/completed/file', async (req, res, next) => {
    try {
      const kind = req.query.kind === 'certificate' ? 'certificate' : 'signed';
      const result = await service.getCompletedFile(req.params.firmId, req.params.workflowId, kind);
      if (!result.success) return next(result.error);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(result.data.bytes.length));
      res.setHeader('X-Content-Sha256', result.data.sha256);
      res.end(result.data.bytes);
    } catch (err) { next(err); }
  });

  // ── The signing ceremony Scentic hosts ──────────────────────────────────────────────────────
  //
  // Scentic authenticates the signer and shows the document itself; these are what it needs from
  // the signing service to do so. All four are for the firm in the path, like every route above.

  // The document's PDF as it stands now — with every signature made so far. X-Content-Sha256 is
  // what a later submission names as the PDF it was built on.
  router.get('/api/v1/firms/:firmId/signature/workflows/:workflowId/ceremony/file', async (req, res, next) => {
    try {
      const result = await service.getCeremonyFile(req.params.firmId, req.params.workflowId);
      if (!result.success) return next(result.error);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', String(result.data.bytes.length));
      res.setHeader('X-Content-Sha256', result.data.sha256);
      res.setHeader('Cache-Control', 'no-store');
      res.end(result.data.bytes);
    } catch (err) { next(err); }
  });

  // The signer opened the document.
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/ceremony/viewed', async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const result = await service.ceremonyViewed(req.params.firmId, req.params.workflowId, { email: b.email, ipAddress: b.ipAddress });
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // The signer's stamped PDF, submitted to the signing service as that signer.
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/ceremony/sign', async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const result = await service.ceremonySign(req.params.firmId, req.params.workflowId, {
        email: b.email,
        pdfBase64: b.pdfBase64,
        signaturePngBase64: b.signaturePngBase64,
        ipAddress: b.ipAddress,
        baseSha256: b.baseSha256,
        auditEvents: b.auditEvents,
      });
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // The signer refuses the document.
  router.post('/api/v1/firms/:firmId/signature/workflows/:workflowId/ceremony/decline', async (req, res, next) => {
    try {
      const b = req.body ?? {};
      const result = await service.ceremonyDecline(req.params.firmId, req.params.workflowId, { email: b.email, reason: b.reason, ipAddress: b.ipAddress });
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Poll all due workflows
  router.post('/api/v1/firms/:firmId/signature/poll-due', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.pollDueWorkflows(
        req.params.firmId,
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  return router;
}

/**
 * What this integration supports. "emulated" means the gateway provides it on top of OpenSign
 * rather than OpenSign providing it; "unsupported" is said rather than left out.
 */
export const SIGNATURE_CAPABILITIES = {
  provider: 'opensign',
  placedFields: 'supported',
  dateSigned: 'supported',
  sequentialSigning: 'supported',
  parallelSigning: 'supported',
  reminders: 'emulated',
  expiry: 'supported',
  decline: 'supported',
  cancel: 'emulated',
  completionCertificate: 'supported',
  signedDocumentDownload: 'supported',
  redirectAfterSigning: 'supported',
  // Changing who signs after sending, and taking a signature back before completion: done by the
  // gateway on OpenSign's own fields, which OpenSign's screens do not offer.
  delegate: 'emulated',
  replaceSigner: 'emulated',
  revokeSignature: 'emulated',
  // Scentic can send every message itself, given each signer's link.
  signerLinks: 'supported',
  // The signing page can be Scentic's own: Scentic authenticates the signer, stamps the PDF and
  // submits it here (`ceremony: 'scentic'` on create, then the .../ceremony/* routes). Emulated: the
  // gateway signs in to OpenSign as the signer; OpenSign has no such interface of its own.
  scenticCeremony: 'emulated',
  // In Scentic's ceremony the signers of one step may sign at the same time, each submission
  // checked against the PDF it was built on (STALE_DOCUMENT when another got there first).
  concurrentSigning: 'emulated',
  // A signer's refusal names the signer: `declinedByEmail` in a status, and that signer's own
  // status reads 'declined'.
  perSignerDecline: 'supported',
  // Scentic's own record of a ceremony (auditEvents on ceremony/sign) is printed on the completion
  // certificate as "Event history" (deploy/opensign-server-files/scenticEventHistory.js).
  certificateEventHistory: 'supported',
  smsVerification: 'unsupported',
  bulkSend: 'unsupported',
} as const;

/** Between one day and a year; anything else is the service's default. */
export function clampDays(value: unknown): number | undefined {
  const days = Math.round(Number(value));
  return Number.isFinite(days) && days >= 1 ? Math.min(days, 365) : undefined;
}

/** An https address, or nothing — a signer is never redirected anywhere else. */
export function httpsUrlOrEmpty(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    return new URL(value).protocol === 'https:' ? value : '';
  } catch {
    return '';
  }
}

/**
 * Fill in what the service assumes and the contract did not require.
 *
 * createWorkflow reads `role` and `scenticSignerId` off every signer, and the
 * route passed the caller's array through untouched. A signer without a role —
 * which is what Scentic actually sent — made `s.role.toLowerCase()` throw, and
 * an unhandled TypeError becomes a bare 500 that says only "An internal error
 * occurred". A missing optional field should not be indistinguishable from the
 * gateway being broken.
 *
 * `signer` is the default because it is the only role that makes sense for
 * somebody named on a document being sent out to be signed.
 */
interface IncomingSigner {
  scenticSignerId?: unknown;
  email?: unknown;
  name?: unknown;
  role?: unknown;
  order?: unknown;
}

export function normaliseSigners(input: unknown): Array<{
  scenticSignerId: string;
  email: string;
  name: string;
  role: string;
  order: number;
}> {
  if (!Array.isArray(input)) return [];

  return input.map((entry, index) => {
    const s = (entry ?? {}) as IncomingSigner;
    const email = typeof s.email === 'string' ? s.email : '';
    return {
      // Falls back to the address, which is what identifies a signer to
      // OpenSign anyway — a counterparty has no Scentic id to send.
      scenticSignerId: typeof s.scenticSignerId === 'string' && s.scenticSignerId ? s.scenticSignerId : email,
      email,
      name: typeof s.name === 'string' && s.name ? s.name : email,
      role: typeof s.role === 'string' && s.role ? s.role : 'signer',
      order: typeof s.order === 'number' ? s.order : index + 1,
    };
  });
}
