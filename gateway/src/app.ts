/**
 * Express app assembly — wires auth, routes, error handling.
 */

import express from 'express';
import type { GatewayConfig } from './config.js';
import { createScenticAuthMiddleware } from './auth/scentic-auth.js';
import { InMemoryNonceStore } from './auth/hmac.js';
import type { NonceStore } from './auth/hmac.js';
import { createHealthRouter, createSourceOfferRouter } from './routes/health.js';
import { createMappingsRouter } from './routes/mappings.js';
import { createTimeRouter } from './routes/time.js';
import { createAdminRouter } from './routes/admin.js';
import { createSignatureRouter } from './routes/signature.js';
import { createStatusRouter, type StatusDeps } from './routes/status.js';
import type { KimaiService } from './kimai/kimai-service.js';
import type { OpenSignService } from './opensign/opensign-service.js';
import type { WebhookDispatcher } from './events/webhook-dispatcher.js';
import type { MappingStore } from './mappings/mapping-store.js';
import type { GatewayError } from './http/errors.js';
import { clearContext, getContext } from './http/request-context.js';

export interface AppDeps {
  config: GatewayConfig;
  kimaiService: KimaiService;
  opensignService?: OpenSignService;
  webhookDispatcher?: WebhookDispatcher;
  mappingStore: MappingStore;
  upstreamSources: { kimaiSha: string; opensignSha: string };
  storeType?: 'memory' | 'sqlite' | 'postgres';
  nonceStoreType?: 'memory' | 'sqlite' | 'redis' | 'postgres';
  outboxStoreType?: 'memory' | 'sqlite' | 'postgres';
  nonceStore?: NonceStore;
}

export function createApp(deps: AppDeps): express.Application {
  const { config, kimaiService, opensignService, webhookDispatcher, mappingStore, upstreamSources } = deps;
  const app = express();

  // Parse JSON bodies (limit to 10MB for document uploads in future)
  app.use(express.json({ limit: '10mb' }));

  // Response headers
  app.use((req, res, next) => {
    res.setHeader('X-Gateway-Version', config.gatewayVersion);
    next();
  });

  // Auth middleware
  const nonceStore = deps.nonceStore ?? new InMemoryNonceStore();
  const authMiddleware = createScenticAuthMiddleware({
    hmacSecret: config.hmacSecret,
    nonceStore,
    timestampToleranceMs: 300_000,
  });

  // Public routes (no auth)
  app.use(createHealthRouter(config));
  app.use(createSourceOfferRouter(config, upstreamSources));

  // Status route (public for local health monitoring)
  app.use(createStatusRouter({
    config,
    kimaiService,
    opensignService,
    webhookDispatcher,
    mappingStore,
    storeType: deps.storeType ?? 'memory',
    nonceStoreType: deps.nonceStoreType ?? 'memory',
    outboxStoreType: deps.outboxStoreType ?? 'memory',
  }));

  // Authenticated routes
  app.use(authMiddleware);
  app.use(createMappingsRouter(kimaiService));
  app.use(createTimeRouter(kimaiService));
  app.use(createAdminRouter(kimaiService));
  if (opensignService) {
    app.use(createSignatureRouter(opensignService));
  }

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
    // Read before clearing: the context is what ties a logged failure to the
    // request the caller saw fail.
    const correlationId = getContext()?.correlationId ?? '';
    clearContext();

    if ('code' in err && 'statusCode' in err && 'toApiError' in err) {
      const gwErr = err as GatewayError & { toApiError: () => unknown };
      res.status(gwErr.statusCode).json({
        ok: false,
        error: gwErr.toApiError(),
      });
    } else {
      // Hidden from the response, not from the operator. Returning a generic
      // message and logging nothing meant an unhandled exception produced a
      // bare 500 with no record anywhere of what threw — the failure was
      // invisible in the gateway's own logs and could only be guessed at from
      // the caller's side.
      console.error('[gateway] unhandled error', {
        correlationId,
        name: err.name,
        message: err.message,
        stack: err.stack,
      });

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
