/**
 * Status route — local health/status summary.
 * Reports gateway, Kimai, OpenSign, webhook, and store states.
 * Never exposes secrets, tokens, signing links, or document data.
 */

import { Router } from 'express';
import type { GatewayConfig } from '../config.js';
import { redactSecret } from '../config.js';
import type { KimaiService } from '../kimai/kimai-service.js';
import type { OpenSignService } from '../opensign/opensign-service.js';
import type { WebhookDispatcher } from '../events/webhook-dispatcher.js';
import type { MappingStore } from '../mappings/mapping-store.js';

export interface StatusDeps {
  config: GatewayConfig;
  kimaiService: KimaiService;
  opensignService?: OpenSignService;
  webhookDispatcher?: WebhookDispatcher;
  mappingStore: MappingStore;
  storeType: 'memory' | 'sqlite' | 'postgres';
  nonceStoreType: 'memory' | 'sqlite' | 'redis';
  outboxStoreType: 'memory' | 'sqlite' | 'postgres';
}

export function createStatusRouter(deps: StatusDeps): Router {
  const router = Router();

  router.get('/api/v1/status', async (_req, res) => {
    const { config, kimaiService, opensignService, webhookDispatcher, mappingStore, storeType, nonceStoreType, outboxStoreType } = deps;

    // Check Kimai health
    let kimaiStatus: { configured: boolean; healthy: boolean } = { configured: false, healthy: false };
    try {
      const kimaiHealth = await kimaiService.checkHealth();
      kimaiStatus = {
        configured: !!config.kimaiBaseUrl,
        healthy: kimaiHealth.success && (kimaiHealth.data as { healthy?: boolean; reachable?: boolean })?.reachable !== false && (kimaiHealth.data as { healthy?: boolean })?.healthy !== false,
      };
    } catch {
      kimaiStatus = { configured: !!config.kimaiBaseUrl, healthy: false };
    }

    // Check OpenSign health
    let opensignStatus: { configured: boolean; enabled: boolean; healthy: boolean } = {
      configured: !!config.opensignBaseUrl,
      enabled: config.opensignEnabled,
      healthy: false,
    };
    if (opensignService && config.opensignEnabled) {
      try {
        const osHealth = await opensignService.checkHealth();
        opensignStatus.healthy = osHealth.success && (osHealth.data as { reachable?: boolean })?.reachable === true;
      } catch {
        opensignStatus.healthy = false;
      }
    }

    // Webhook dispatch status
    const webhookStatus = webhookDispatcher
      ? { configured: webhookDispatcher.isEnabled(), enabled: webhookDispatcher.isEnabled() }
      : { configured: false, enabled: false };

    const webhookStats = webhookDispatcher?.getStats();

    res.json({
      ok: true,
      data: {
        gateway: {
          version: config.gatewayVersion,
          env: config.env,
          port: config.port,
          productionReadiness: false,
        },
        providers: {
          kimai: {
            configured: kimaiStatus.configured,
            healthy: kimaiStatus.healthy,
            baseUrl: redactSecret(config.kimaiBaseUrl),
          },
          opensign: {
            configured: opensignStatus.configured,
            enabled: opensignStatus.enabled,
            healthy: opensignStatus.healthy,
            baseUrl: config.opensignEnabled ? redactSecret(config.opensignBaseUrl) : '(disabled)',
          },
        },
        webhook: {
          configured: webhookStatus.configured,
          enabled: webhookStatus.enabled,
          targetUrl: config.webhookTargetUrl ? redactSecret(config.webhookTargetUrl) : '(not set)',
          stats: webhookStats ?? { dispatched: 0, delivered: 0, failed: 0, enabled: false },
        },
        stores: {
          mapping: storeType,
          nonce: nonceStoreType,
          outbox: outboxStoreType,
        },
        sourceOffer: {
          route: '/source',
          available: true,
        },
        warnings: [
          ...(storeType === 'memory' ? ['In-memory mapping store — data lost on restart'] : []),
          ...(nonceStoreType === 'memory' ? ['In-memory nonce store — not suitable for multi-instance'] : []),
          ...(outboxStoreType === 'memory' ? ['In-memory outbox — events lost on restart'] : []),
          'Production readiness: false',
          'Scentic core integration: not connected (interface spec only)',
        ],
        blockers: [
          'Durable production mapping store required (SQLite/Postgres)',
          'Redis/shared nonce store required for multi-instance',
          'Real Kimai container contract test evidence required',
          'Real OpenSign container contract test evidence required',
          'OpenSign master key IP allowlist hardening required',
          'PFX certificate provisioning required',
          'Production GCP project and secrets required',
          'Scentic core changes not applied (documentation only)',
          'Scentic webhook receiver not implemented in core',
        ],
      },
    });
  });

  return router;
}
