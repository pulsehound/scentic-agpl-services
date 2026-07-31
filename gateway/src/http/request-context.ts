/**
 * Request context — attached to every authenticated request.
 */

export interface RequestContext {
  correlationId: string;
  firmId: string;
  userId?: string;
  idempotencyKey?: string;
  timestamp: number;
  nonce: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __requestContext: RequestContext | undefined;
}

export function setContext(ctx: RequestContext): void {
  globalThis.__requestContext = ctx;
}

export function getContext(): RequestContext | undefined {
  return globalThis.__requestContext;
}

export function clearContext(): void {
  globalThis.__requestContext = undefined;
}

export function generateCorrelationId(): string {
  return crypto.randomUUID();
}
