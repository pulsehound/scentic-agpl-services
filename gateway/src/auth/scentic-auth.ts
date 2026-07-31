/**
 * Scentic service-to-service authentication middleware.
 *
 * Required headers:
 * - X-Scentic-Timestamp
 * - X-Scentic-Nonce
 * - X-Scentic-Signature
 * - X-Scentic-Firm-Id
 * - X-Scentic-User-Id (optional, where applicable)
 * - X-Scentic-Correlation-Id (optional, generated if absent)
 * - Idempotency-Key (optional, required for writes)
 *
 * Security:
 * - Missing headers → 401
 * - Bad signature → 401
 * - Stale timestamp → 401
 * - Replayed nonce → 401
 * - Path Firm ID mismatch → 403
 * - No secrets in error messages or logs
 */

import type { Request, Response, NextFunction } from 'express';
import { verifySignature, isTimestampValid, type NonceStore } from './hmac.js';
import { computeBodyHash } from './hmac.js';
import { unauthorized, firmScopeViolation } from '../http/errors.js';
import { setContext, generateCorrelationId, clearContext } from '../http/request-context.js';

export interface AuthConfig {
  hmacSecret: string;
  nonceStore: NonceStore;
  timestampToleranceMs: number;
}

// Routes that don't require HMAC auth
const PUBLIC_ROUTES = new Set(['/health', '/source']);

export function createScenticAuthMiddleware(authConfig: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth for public routes
    if (PUBLIC_ROUTES.has(req.path)) {
      const correlationId = req.headers['x-scentic-correlation-id'] as string | undefined;
      const ctx = {
        correlationId: correlationId || generateCorrelationId(),
        firmId: '',
        timestamp: Date.now(),
        nonce: '',
      };
      res.setHeader('X-Correlation-Id', ctx.correlationId);
      setContext(ctx);
      return next();
    }

    const timestamp = req.headers['x-scentic-timestamp'] as string | undefined;
    const nonce = req.headers['x-scentic-nonce'] as string | undefined;
    const signature = req.headers['x-scentic-signature'] as string | undefined;
    const firmId = req.headers['x-scentic-firm-id'] as string | undefined;
    const userId = req.headers['x-scentic-user-id'] as string | undefined;
    const correlationId = (req.headers['x-scentic-correlation-id'] as string | undefined) || generateCorrelationId();

    res.setHeader('X-Correlation-Id', correlationId);

    // Check required headers
    if (!timestamp || !nonce || !signature || !firmId) {
      return next(unauthorized('Missing required authentication headers'));
    }

    // Check timestamp freshness
    if (!isTimestampValid(timestamp, authConfig.timestampToleranceMs)) {
      return next(unauthorized('Request timestamp is stale'));
    }

    // Check nonce replay
    const tsNum = parseInt(timestamp, 10);
    if (authConfig.nonceStore.seen(nonce, tsNum)) {
      return next(unauthorized('Request nonce has already been used'));
    }

    // Verify signature
    const bodyHash = computeBodyHash(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? ''));
    const valid = verifySignature(authConfig.hmacSecret, {
      method: req.method,
      path: req.path,
      queryString: req.query ? new URLSearchParams(req.query as Record<string, string>).toString() : '',
      timestamp,
      nonce,
      bodyHash,
      firmId,
      userId,
      correlationId,
    }, signature);

    if (!valid) {
      return next(unauthorized('Invalid request signature'));
    }

    // Verify path Firm ID matches signed Firm ID
    const pathFirmId = req.params['firmId'];
    if (pathFirmId && pathFirmId !== firmId) {
      return next(firmScopeViolation('Path firm ID does not match authenticated firm ID'));
    }

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;

    setContext({
      correlationId,
      firmId,
      userId,
      idempotencyKey,
      timestamp: tsNum,
      nonce,
    });

    next();
  };
}

export { clearContext };
