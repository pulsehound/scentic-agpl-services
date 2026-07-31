/**
 * Mapping sync routes — create/update Scentic ↔ Kimai entity mappings.
 * All routes are Firm-scoped and require HMAC auth.
 */

import { Router } from 'express';
import type { KimaiService } from '../kimai/kimai-service.js';
import { invalidInput } from '../http/errors.js';
import { getContext } from '../http/request-context.js';

export function createMappingsRouter(service: KimaiService): Router {
  const router = Router();

  router.post('/api/v1/firms/:firmId/init', async (req, res, next) => {
    try {
      const ctx = getContext();
      const { firmName } = req.body ?? {};
      if (!firmName || typeof firmName !== 'string') {
        return next(invalidInput('firmName is required'));
      }
      const result = await service.initFirm({
        scenticFirmId: req.params.firmId,
        firmName,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  router.post('/api/v1/firms/:firmId/users/sync', async (req, res, next) => {
    try {
      const ctx = getContext();
      const { scenticUserId, email, firstName, lastName } = req.body ?? {};
      if (!scenticUserId || !email) {
        return next(invalidInput('scenticUserId and email are required'));
      }
      const result = await service.syncUser({
        scenticFirmId: req.params.firmId,
        scenticUserId,
        email,
        firstName,
        lastName,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: { scenticUserId: result.data.scenticUserId, kimaiUserId: result.data.kimaiUserId, status: result.data.status } });
    } catch (err) { next(err); }
  });

  router.post('/api/v1/firms/:firmId/clients/sync', async (req, res, next) => {
    try {
      const ctx = getContext();
      const { scenticClientId, clientName } = req.body ?? {};
      if (!scenticClientId || !clientName) {
        return next(invalidInput('scenticClientId and clientName are required'));
      }
      const result = await service.syncClient({
        scenticFirmId: req.params.firmId,
        scenticClientId,
        clientName,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: { scenticClientId: result.data.scenticClientId, kimaiCustomerId: result.data.kimaiCustomerId, status: result.data.status } });
    } catch (err) { next(err); }
  });

  router.post('/api/v1/firms/:firmId/matters/sync', async (req, res, next) => {
    try {
      const ctx = getContext();
      const { scenticMatterId, scenticClientId, matterName, matterCode } = req.body ?? {};
      if (!scenticMatterId || !scenticClientId || !matterName) {
        return next(invalidInput('scenticMatterId, scenticClientId, and matterName are required'));
      }
      const result = await service.syncMatter({
        scenticFirmId: req.params.firmId,
        scenticMatterId,
        scenticClientId,
        matterName,
        matterCode,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: { scenticMatterId: result.data.scenticMatterId, kimaiProjectId: result.data.kimaiProjectId, status: result.data.status } });
    } catch (err) { next(err); }
  });

  router.post('/api/v1/firms/:firmId/activities/sync', async (req, res, next) => {
    try {
      const ctx = getContext();
      const { scenticActivityCode, activityName } = req.body ?? {};
      if (!scenticActivityCode || !activityName) {
        return next(invalidInput('scenticActivityCode and activityName are required'));
      }
      const result = await service.syncActivity({
        scenticFirmId: req.params.firmId,
        scenticActivityCode,
        activityName,
      }, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: { scenticActivityCode: result.data.scenticActivityCode, kimaiActivityId: result.data.kimaiActivityId, status: result.data.status } });
    } catch (err) { next(err); }
  });

  return router;
}
