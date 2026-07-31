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
        signers: b.signers ?? [],
        sendNow: b.sendNow ?? true,
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
        b.scenticSignerIds ?? [],
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
