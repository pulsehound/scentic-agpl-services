/**
 * Express app assembly — wires auth, routes, error handling.
 */

import express from 'express';
import type { GatewayConfig } from './config.js';
import { createScenticAuthMiddleware } from './auth/scentic-auth.js';
import { InMemoryNonceStore } from './auth/hmac.js';
import { createHealthRouter, createSourceOfferRouter } from './routes/health.js';
import { createMappingsRouter } from './routes/mappings.js';
import { createTimeRouter } from './routes/time.js';
import { createAdminRouter } from './routes/admin.js';
import type { KimaiService } from './kimai/kimai-service.js';
import type { GatewayError } from './http/errors.js';
import { clearContext } from './http/request-context.js';

export interface AppDeps {
  config: GatewayConfig;
  kimaiService: KimaiService;
  upstreamSources: { kimaiSha: string; opensignSha: string };
}

export function createApp(deps: AppDeps): express.Application {
  const { config, kimaiService, upstreamSources } = deps;
  const app = express();

  // Parse JSON bodies (limit to 10MB for document uploads in future)
  app.use(express.json({ limit: '10mb' }));

  // Response headers
  app.use((req, res, next) => {
    res.setHeader('X-Gateway-Version', config.gatewayVersion);
    next();
  });

  // Auth middleware
  const nonceStore = new InMemoryNonceStore();
  const authMiddleware = createScenticAuthMiddleware({
    hmacSecret: config.hmacSecret,
    nonceStore,
    timestampToleranceMs: 300_000,
  });

  // Public routes (no auth)
  app.use(createHealthRouter(config));
  app.use(createSourceOfferRouter(config, upstreamSources));

  // Authenticated routes
  app.use(authMiddleware);
  app.use(createMappingsRouter(kimaiService));
  app.use(createTimeRouter(kimaiService));
  app.use(createAdminRouter(kimaiService));

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        retryable: false,
      },
    });
  });

  // Error handler
  app.use((err: Error | GatewayError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    clearContext();

    if ('code' in err && 'statusCode' in err && 'toApiError' in err) {
      const gwErr = err as GatewayError & { toApiError: () => unknown };
      res.status(gwErr.statusCode).json({
        ok: false,
        error: gwErr.toApiError(),
      });
    } else {
      // Never expose internal error details
      res.status(500).json({
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An internal error occurred',
          retryable: false,
        },
      });
    }
  });

  return app;
}
