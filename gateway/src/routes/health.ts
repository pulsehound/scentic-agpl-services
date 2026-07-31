/**
 * Health and source-offer routes (public, no auth required).
 */

import { Router } from 'express';
import type { GatewayConfig } from '../config.js';
import { redactSecret } from '../config.js';

export function createHealthRouter(config: GatewayConfig): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      data: {
        status: 'healthy',
        version: config.gatewayVersion,
        env: config.env,
        kimaiBaseUrl: redactSecret(config.kimaiBaseUrl),
        timestamp: new Date().toISOString(),
      },
    });
  });

  return router;
}

export function createSourceOfferRouter(config: GatewayConfig, upstreamSources: { kimaiSha: string; opensignSha: string }): Router {
  const router = Router();

  router.get('/source', (_req, res) => {
    res.json({
      ok: true,
      data: {
        license: 'AGPL-3.0',
        licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
        repoUrl: 'https://github.com/pulsehound/scentic-agpl-services',
        upstream: {
          kimai: {
            name: 'Kimai',
            url: 'https://github.com/kimai/kimai',
            license: 'AGPL-3.0-or-later',
            pinnedCommit: upstreamSources.kimaiSha,
          },
          opensign: {
            name: 'OpenSign',
            url: 'https://github.com/OpenSignLabs/OpenSign',
            license: 'AGPL-3.0',
            pinnedCommit: upstreamSources.opensignSha,
          },
        },
        buildInstructions: 'See docs/DEPLOYMENT.md',
        sourceOfferDoc: 'See docs/SOURCE_OFFER.md',
        gatewayVersion: config.gatewayVersion,
        notice: 'This software is licensed under AGPL-3.0. Source code is available at the repo URL above.',
      },
    });
  });

  return router;
}
