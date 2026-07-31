/**
 * Admin routes — firm management, test connection, secret rotation stubs.
 */

import { Router } from 'express';
import type { KimaiService } from '../kimai/kimai-service.js';
import { invalidInput, notFound } from '../http/errors.js';
import { getContext } from '../http/request-context.js';

export function createAdminRouter(service: KimaiService): Router {
  const router = Router();

  // Disable firm
  router.post('/api/v1/firms/:firmId/disable', async (req, res, next) => {
    try {
      const ctx = getContext();
      const result = await service.disableFirm(req.params.firmId, ctx?.correlationId ?? '');
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: { disabled: true } });
    } catch (err) { next(err); }
  });

  // Test connection
  router.post('/api/v1/admin/test-connection', async (_req, res, next) => {
    try {
      const result = await service.testConnection();
      if (!result.success) return next(result.error);
      res.json({ ok: true, data: result.data });
    } catch (err) { next(err); }
  });

  return router;
}
