/**
 * Gateway server entrypoint.
 */

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { KimaiClient } from './kimai/kimai-client.js';
import { KimaiService } from './kimai/kimai-service.js';
import { OpenSignClient } from './opensign/opensign-client.js';
import { OpenSignService } from './opensign/opensign-service.js';
import { WebhookDispatcher, createWebhookDispatcherConfig } from './events/webhook-dispatcher.js';
import { createStoreBundle, createStoreConfigFromEnv } from './storage/store-factory.js';

// Upstream source SHAs (pinned in docs/UPSTREAM_SOURCES.md)
const KIMAI_SHA = '7c2ed4b07cca2e15b1ab4cc5947afdf899a76401';
const OPENSIGN_SHA = 'f72624fa26211fe00776453d99a67120a4f5e060';

async function main() {
  const config = loadConfig(process.env as Record<string, string | undefined>);

  const kimaiClient = new KimaiClient({
    baseUrl: config.kimaiBaseUrl,
    apiToken: config.kimaiAdminApiToken,
    username: config.kimaiAdminUsername,
  });

  // Durable store bundle (memory, sqlite, or postgres)
  const storeBundle = await createStoreBundle(createStoreConfigFromEnv(process.env as Record<string, string | undefined>));
  const { mappingStore, nonceStore, outbox } = storeBundle;

  const kimaiService = new KimaiService(kimaiClient, mappingStore, outbox, {
    useConfidentialLabels: config.useConfidentialLabels,
    defaultActivityName: config.defaultActivityName,
    adminUsername: config.kimaiAdminUsername,
    adminApiToken: config.kimaiAdminApiToken,
  });

  // OpenSign service (optional, only if enabled)
  let opensignService: OpenSignService | undefined;
  if (config.opensignEnabled) {
    const opensignClient = new OpenSignClient({
      baseUrl: config.opensignBaseUrl,
      appId: config.opensignAppId,
      masterKey: config.opensignMasterKey,
      adminEmail: config.opensignAdminEmail,
      adminPassword: config.opensignAdminPassword,
    });
    opensignService = new OpenSignService(opensignClient, mappingStore, outbox, {
      enabled: config.opensignEnabled,
      pollIntervalSeconds: config.opensignPollIntervalSeconds,
      completionTimeoutSeconds: config.opensignCompletionTimeoutSeconds,
    });
  }

  // Webhook dispatcher
  const webhookDispatcher = new WebhookDispatcher(
    createWebhookDispatcherConfig({
      targetUrl: config.webhookTargetUrl,
      hmacSecret: config.webhookHmacSecret,
    }),
    outbox,
  );

  const app = createApp({
    config,
    kimaiService,
    opensignService,
    webhookDispatcher,
    mappingStore,
    nonceStore,
    upstreamSources: { kimaiSha: KIMAI_SHA, opensignSha: OPENSIGN_SHA },
    storeType: storeBundle.storeType,
    nonceStoreType: storeBundle.nonceStoreType,
    outboxStoreType: storeBundle.outboxStoreType,
  });

  const server = app.listen(config.port, () => {
    console.log(`[gateway] Listening on port ${config.port} (env: ${config.env})`);
    console.log(`[gateway] Kimai base URL: ${config.kimaiBaseUrl}`);
    console.log(`[gateway] OpenSign enabled: ${config.opensignEnabled}`);
    console.log(`[gateway] Gateway version: ${config.gatewayVersion}`);
    console.log(`[gateway] Store type: ${storeBundle.storeType} (nonce: ${storeBundle.nonceStoreType}, outbox: ${storeBundle.outboxStoreType})`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('[gateway] SIGTERM received, shutting down...');
    server.close(async () => {
      await storeBundle.close?.();
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('[gateway] SIGINT received, shutting down...');
    server.close(async () => {
      await storeBundle.close?.();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error('[gateway] Failed to start:', err.message);
  process.exit(1);
});
