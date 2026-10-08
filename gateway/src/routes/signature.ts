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
  delegate: 'unsupported',
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
