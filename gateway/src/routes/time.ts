/**
 * Time tracking routes — CRUD for time entries via Kimai.
 * All routes are Firm-scoped and require HMAC auth.
 */

import { Router } from 'express';
import type { KimaiService } from '../kimai/kimai-service.js';
import { invalidInput } from '../http/errors.js';
import { getContext } from '../http/request-context.js';

export function createTimeRouter(service: KimaiService): Router {
  const router = Router();

  // Create time entry
  router.post('/api/v1/firms/:firmId/time-entries', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      if (!b.scenticUserId || !b.scenticMatterId || !b.scenticActivityCode || !b.scenticTimeEntryId || !b.startAt) {
        return next(invalidInput('scenticUserId, scenticMatterId, scenticActivityCode, scenticTimeEntryId, and startAt are required'));
      }
      const result = await service.createTimeEntry({
        scenticFirmId: req.params.firmId,
        scenticUserId: b.scenticUserId,
        scenticMatterId: b.scenticMatterId,
        scenticActivityCode: b.scenticActivityCode,
        scenticTimeEntryId: b.scenticTimeEntryId,
        startAt: b.startAt,
        endAt: b.endAt,
        durationSeconds: b.durationSeconds,
        description: b.description,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // List time entries
  router.get('/api/v1/firms/:firmId/time-entries', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.listTimeEntries({
        scenticFirmId: req.params.firmId,
        scenticUserId: req.query['scenticUserId'] as string | undefined,
        scenticMatterId: req.query['scenticMatterId'] as string | undefined,
        startDate: req.query['startDate'] as string | undefined,
        endDate: req.query['endDate'] as string | undefined,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Get single time entry
  router.get('/api/v1/firms/:firmId/time-entries/:entryId', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.listTimeEntries({
        scenticFirmId: req.params.firmId,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      const entry = result.data.find(m => m.scenticTimeEntryId === req.params.entryId);
      if (!entry) return res.json({ ok: true, data: null });
      res.json({ ok: true, data: entry });
    } catch (err) { next(err); }
  });

  // Update time entry
  router.patch('/api/v1/firms/:firmId/time-entries/:entryId', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      const result = await service.updateTimeEntry({
        scenticFirmId: req.params.firmId,
        scenticTimeEntryId: req.params.entryId,
        startAt: b.startAt,
        endAt: b.endAt,
        durationSeconds: b.durationSeconds,
        description: b.description,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Delete time entry
  router.delete('/api/v1/firms/:firmId/time-entries/:entryId', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.deleteTimeEntry(
        req.params.firmId,
        req.params.entryId,
        ctx?.correlationId ?? '',
      );
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: null });
    } catch (err) { next(err); }
  });

  // Export time entries
  router.post('/api/v1/firms/:firmId/time-entries/export', async (req, res, next) => {
    try {
      const ctx = getContext();
      const b = req.body ?? {};
      const result = await service.exportTimeEntries({
        scenticFirmId: req.params.firmId,
        scenticUserId: b.scenticUserId,
        scenticMatterId: b.scenticMatterId,
        startDate: b.startDate,
        endDate: b.endDate,
        format: b.format,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  // Kimai provider health
  router.get('/api/v1/providers/kimai/health', async (_req, res, next) => {
    try {
      const result = await service.checkHealth();
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  return router;
}
