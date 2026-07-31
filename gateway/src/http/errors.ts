/**
 * HTTP error types and safe error responses.
 *
 * Security invariants:
 * - Never expose raw upstream errors to the client
 * - Never include secrets in error messages
 * - Error codes are stable and documented
 */

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'FIRM_SCOPE_VIOLATION'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'NOT_SUPPORTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR'
  | 'IDEMPOTENCY_KEY_REUSE';

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Array<{ field: string; issue: string }>;
  retryable: boolean;
}

export class GatewayError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Array<{ field: string; issue: string }>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  toApiError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export function unauthorized(message: string): GatewayError {
  return new GatewayError('UNAUTHORIZED', message, 401, undefined, false);
}

export function forbidden(message: string): GatewayError {
  return new GatewayError('FORBIDDEN', message, 403, undefined, false);
}

export function firmScopeViolation(message: string): GatewayError {
  return new GatewayError('FIRM_SCOPE_VIOLATION', message, 403, undefined, false);
}

export function notFound(message: string): GatewayError {
  return new GatewayError('NOT_FOUND', message, 404, undefined, false);
}

export function invalidInput(message: string, details?: Array<{ field: string; issue: string }>): GatewayError {
  return new GatewayError('INVALID_INPUT', message, 400, details, false);
}

export function conflict(message: string): GatewayError {
  return new GatewayError('CONFLICT', message, 409, undefined, false);
}

export function rateLimited(message: string): GatewayError {
  return new GatewayError('RATE_LIMITED', message, 429, undefined, true);
}

export function notSupported(message: string): GatewayError {
  return new GatewayError('NOT_SUPPORTED', message, 501, undefined, false);
}

export function upstreamUnavailable(message: string): GatewayError {
  return new GatewayError('UPSTREAM_UNAVAILABLE', message, 502, undefined, true);
}

export function upstreamError(message: string): GatewayError {
  return new GatewayError('UPSTREAM_ERROR', message, 502, undefined, true);
}

export function internalError(message: string): GatewayError {
  return new GatewayError('INTERNAL_ERROR', message, 500, undefined, false);
}

/**
 * Wrap an upstream error safely — never expose raw upstream response bodies.
 */
export function wrapUpstreamError(provider: string, operation: string, _rawError: unknown): GatewayError {
  // Never include raw error details in the message
  return upstreamError(`${provider} ${operation} failed. Check gateway logs for details.`);
}
