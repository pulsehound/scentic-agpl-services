/**
 * Gateway configuration — strict env validation.
 *
 * Security invariants:
 * - Production rejects missing or placeholder HMAC secrets
 * - Production rejects public internal URLs
 * - Secrets are never logged
 * - Local/dev may use explicit dev placeholders only if NODE_ENV !== production
 */

export type Environment = 'production' | 'staging' | 'local';

export interface GatewayConfig {
  env: Environment;
  port: number;
  publicBaseUrl: string;
  internalBaseUrl: string;
  hmacSecret: string;
  webhookTargetUrl: string;
  webhookHmacSecret: string;
  kimaiBaseUrl: string;
  kimaiAdminUsername: string;
  kimaiAdminApiToken: string;
  databaseUrl: string | null;
  defaultActivityName: string;
  useConfidentialLabels: boolean;
  logLevel: string;
  gatewayVersion: string;
}

const PLACEHOLDER_VALUES = new Set([
  '',
  'changeme',
  'dev-secret',
  'placeholder',
  'xxx',
  'test',
]);

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_VALUES.has(value.toLowerCase().trim());
}

function isPrivateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.endsWith('.local') || host.endsWith('.internal')) return true;
    // RFC 1918
    if (/^10\./.test(host)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    // IPv6 ULA and link-local
    if (/^f[cd]/.test(host)) return true;
    if (/^fe80/.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

export function loadConfig(env: Record<string, string | undefined>): GatewayConfig {
  const nodeEnv = (env['NODE_ENV'] ?? 'development').toLowerCase();
  const isProduction = nodeEnv === 'production';

  const envLevel: Environment = isProduction ? 'production'
    : nodeEnv === 'staging' ? 'staging'
    : 'local';

  const hmacSecret = env['SCENTIC_SHARED_HMAC_SECRET'] ?? '';
  const webhookHmacSecret = env['SCENTIC_WEBHOOK_HMAC_SECRET'] ?? '';
  const internalBaseUrl = env['SCENTIC_GATEWAY_INTERNAL_BASE_URL'] ?? '';
  const publicBaseUrl = env['SCENTIC_GATEWAY_PUBLIC_BASE_URL'] ?? '';
  const webhookTargetUrl = env['SCENTIC_WEBHOOK_TARGET_URL'] ?? '';
  const kimaiBaseUrl = env['KIMAI_BASE_URL'] ?? '';
  const kimaiAdminApiToken = env['KIMAI_ADMIN_API_TOKEN'] ?? '';

  if (isProduction) {
    const errors: string[] = [];
    if (!hmacSecret || isPlaceholder(hmacSecret)) {
      errors.push('SCENTIC_SHARED_HMAC_SECRET must be set to a strong non-placeholder value in production');
    }
    if (!webhookHmacSecret || isPlaceholder(webhookHmacSecret)) {
      errors.push('SCENTIC_WEBHOOK_HMAC_SECRET must be set to a strong non-placeholder value in production');
    }
    if (!internalBaseUrl) {
      errors.push('SCENTIC_GATEWAY_INTERNAL_BASE_URL must be set in production');
    }
    if (internalBaseUrl && !isPrivateUrl(internalBaseUrl)) {
      errors.push('SCENTIC_GATEWAY_INTERNAL_BASE_URL must be a private network URL in production');
    }
    if (!publicBaseUrl) {
      errors.push('SCENTIC_GATEWAY_PUBLIC_BASE_URL must be set in production');
    }
    if (!webhookTargetUrl) {
      errors.push('SCENTIC_WEBHOOK_TARGET_URL must be set in production');
    }
    if (!kimaiBaseUrl) {
      errors.push('KIMAI_BASE_URL must be set in production');
    }
    if (kimaiBaseUrl && !isPrivateUrl(kimaiBaseUrl)) {
      errors.push('KIMAI_BASE_URL must be a private network URL in production');
    }
    if (!kimaiAdminApiToken || isPlaceholder(kimaiAdminApiToken)) {
      errors.push('KIMAI_ADMIN_API_TOKEN must be set in production');
    }
    if (errors.length > 0) {
      throw new Error(`Gateway config validation failed:\n  - ${errors.join('\n  - ')}`);
    }
  }

  return {
    env: envLevel,
    port: parseInt(env['GATEWAY_PORT'] ?? '3101', 10),
    publicBaseUrl: publicBaseUrl || 'http://localhost:3101',
    internalBaseUrl: internalBaseUrl || 'http://localhost:3101',
    hmacSecret: hmacSecret || 'dev-hmac-secret',
    webhookTargetUrl: webhookTargetUrl || '',
    webhookHmacSecret: webhookHmacSecret || 'dev-webhook-hmac-secret',
    kimaiBaseUrl: kimaiBaseUrl || 'http://localhost:8001',
    kimaiAdminUsername: env['KIMAI_ADMIN_USERNAME'] ?? 'admin',
    kimaiAdminApiToken: kimaiAdminApiToken || 'dev-api-token',
    databaseUrl: env['GATEWAY_DATABASE_URL'] ?? null,
    defaultActivityName: env['KIMAI_DEFAULT_ACTIVITY_NAME'] ?? 'General',
    useConfidentialLabels: (env['KIMAI_USE_CONFIDENTIAL_LABELS'] ?? 'false').toLowerCase() === 'true',
    logLevel: env['LOG_LEVEL'] ?? 'info',
    gatewayVersion: '0.1.0',
  };
}

export function redactSecret(value: string): string {
  if (!value) return '(not set)';
  if (value.length <= 8) return '****';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

export type { GatewayConfig as Config };
