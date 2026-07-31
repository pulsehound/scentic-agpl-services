/**
 * Shared test helpers for the scentic-agpl-services gateway test suite.
 *
 * These helpers construct a real Express app (via createApp) wired to a
 * controllable mock KimaiClient, plus utilities to produce valid HMAC
 * signed requests matching createScenticAuthMiddleware exactly.
 */

import { createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import request, { type Test } from 'supertest';
import { vi } from 'vitest';

import type { GatewayConfig } from '../config.js';
import { InMemoryMappingStore } from '../mappings/mapping-store.js';
import { InMemoryEventOutbox } from '../events/outbox.js';
import { KimaiService } from '../kimai/kimai-service.js';
import { createApp } from '../app.js';
import { InMemoryNonceStore } from '../auth/hmac.js';

// ─── Mock KimaiClient ──────────────────────────────────────────────────────

/**
 * A mock KimaiClient whose every method is a vi.fn() returning a successful
 * result by default. Specific methods can be overridden via `overrides`, and
 * every call is recorded for later assertion via the returned `client` object.
 */
export function makeMockKimaiClient(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const defaults = {
    setToken: vi.fn(),
    getStatus: vi.fn(async () => ({ success: true, data: { version: '2.0.0' } })),
    listTeams: vi.fn(async () => ({ success: true, data: [{ id: 1, name: 'team-1' }] })),
    createTeam: vi.fn(async (name: string) => ({ success: true, data: { id: 101, name, teamlead: 1 } })),
    listUsers: vi.fn(async () => ({ success: true, data: [] as unknown[] })),
    createUser: vi.fn(async (p: { username: string; email: string }) => ({
      success: true,
      data: { id: 201, username: p.username, email: p.email, enabled: true },
    })),
    updateUser: vi.fn(async (id: number) => ({ success: true, data: { id, enabled: true } })),
    listCustomers: vi.fn(async () => ({ success: true, data: [] as unknown[] })),
    createCustomer: vi.fn(async (p: { name: string }) => ({
      success: true,
      data: { id: 301, name: p.name, visible: true, team: p.team },
    })),
    listProjects: vi.fn(async () => ({ success: true, data: [] as unknown[] })),
    createProject: vi.fn(async (p: { name: string; customer: number }) => ({
      success: true,
      data: { id: 401, name: p.name, customer: p.customer, visible: true, team: p.team },
    })),
    listActivities: vi.fn(async () => ({ success: true, data: [] as unknown[] })),
    createActivity: vi.fn(async (p: { name: string }) => ({
      success: true,
      data: { id: 501, name: p.name, visible: true },
    })),
    listTimesheets: vi.fn(async () => ({ success: true, data: [] as unknown[] })),
    createTimesheet: vi.fn(async (p: { begin: string; activity: number; project: number; user: number }) => ({
      success: true,
      data: { id: 601, begin: p.begin, activity: p.activity, project: p.project, user: p.user },
    })),
    getTimesheet: vi.fn(async (id: number) => ({ success: true, data: { id } })),
    updateTimesheet: vi.fn(async (id: number, p: Record<string, unknown>) => ({
      success: true,
      data: { id, ...p },
    })),
    deleteTimesheet: vi.fn(async () => ({ success: true, data: undefined })),
    exportTimesheets: vi.fn(async () => ({ success: true, data: { url: 'http://export/kimai-export.csv' } })),
  };

  return { ...defaults, ...overrides };
}

export type MockKimaiClient = ReturnType<typeof makeMockKimaiClient>;

// ─── Test config ────────────────────────────────────────────────────────────

export function makeTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    env: 'local',
    port: 3101,
    publicBaseUrl: 'http://localhost:3101',
    internalBaseUrl: 'http://localhost:3101',
    hmacSecret: 'test-hmac-secret',
    webhookTargetUrl: 'http://localhost:9000/webhook',
    webhookHmacSecret: 'test-webhook-hmac-secret',
    kimaiBaseUrl: 'http://localhost:8001',
    kimaiAdminUsername: 'admin',
    kimaiAdminApiToken: 'test-api-token-secret',
    databaseUrl: null,
    defaultActivityName: 'General',
    useConfidentialLabels: true,
    logLevel: 'info',
    gatewayVersion: '0.1.0',
    ...overrides,
  };
}

// ─── Signed headers ─────────────────────────────────────────────────────────

/**
 * Replicates the body-hash computation used by createScenticAuthMiddleware:
 * the middleware receives the *parsed* body from express.json() and re-serializes
 * it with JSON.stringify(req.body ?? ''). For a request with no body, req.body is
 * undefined and the material becomes JSON.stringify('') === '""'.
 *
 * computeBodyHash in auth/hmac.ts is a plain SHA-256 (HMAC with empty key).
 */
function computeTestBodyHash(body: string | undefined): string {
  let material: string;
  if (body === undefined || body === '') {
    // express.json() initializes req.body = {} even for bodyless requests
    // (GET/DELETE with no body), so the middleware computes
    // JSON.stringify({} ?? '') === '{}'. We must match that exactly.
    material = '{}';
  } else {
    // Re-serialize the parsed object exactly as the middleware does after
    // express.json() parses the raw JSON string we send.
    material = JSON.stringify(JSON.parse(body));
  }
  return createHmac('sha256', '').update(Buffer.from(material)).digest('hex');
}

/**
 * Replicates the query-string canonicalization used by the middleware:
 * new URLSearchParams(req.query as Record<string,string>).toString()
 */
function canonicalQueryString(path: string): string {
  const qIndex = path.indexOf('?');
  if (qIndex < 0) return '';
  const raw = path.slice(qIndex + 1);
  if (!raw) return '';
  const record = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  return new URLSearchParams(record).toString();
}

export interface SignedHeadersOpts {
  method: string;
  /** Full path including optional query string. */
  path: string;
  /** Raw JSON string that will be sent as the body, or undefined for no body. */
  body?: string;
  firmId: string;
  secret?: string;
  userId?: string;
  nonce?: string;
  timestamp?: string;
  correlationId?: string;
  idempotencyKey?: string;
  /** Omit the X-Scentic-Signature header entirely. */
  omitSignature?: boolean;
  /** Include a deliberately wrong signature value. */
  badSignature?: boolean;
}

/**
 * Computes the correct HMAC signature and returns all required auth headers.
 */
export function makeSignedHeaders(opts: SignedHeadersOpts): Record<string, string> {
  const secret = opts.secret ?? 'test-hmac-secret';
  const timestamp = opts.timestamp ?? String(Date.now());
  const nonce = opts.nonce ?? randomUUID();
  const correlationId = opts.correlationId ?? randomUUID();
  const pathname = opts.path.split('?')[0];
  const queryString = canonicalQueryString(opts.path);
  const bodyHash = computeTestBodyHash(opts.body);

  const canonicalString = [
    opts.method.toUpperCase(),
    pathname,
    queryString,
    timestamp,
    nonce,
    bodyHash,
    opts.firmId,
    opts.userId ?? '',
    correlationId,
  ].join('\n');

  const signature = createHmac('sha256', secret).update(canonicalString).digest('hex');

  const headers: Record<string, string> = {
    'X-Scentic-Timestamp': timestamp,
    'X-Scentic-Nonce': nonce,
    'X-Scentic-Firm-Id': opts.firmId,
    'X-Scentic-Correlation-Id': correlationId,
  };
  if (opts.userId) headers['X-Scentic-User-Id'] = opts.userId;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (!opts.omitSignature) {
    headers['X-Scentic-Signature'] = opts.badSignature ? '0'.repeat(64) : signature;
  }
  if (opts.body !== undefined && opts.body !== '') {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

// ─── Test app ───────────────────────────────────────────────────────────────

export interface TestApp {
  app: express.Application;
  store: InMemoryMappingStore;
  outbox: InMemoryEventOutbox;
  client: MockKimaiClient;
  config: GatewayConfig;
  service: KimaiService;
}

export interface MakeAppOpts {
  config?: GatewayConfig;
  client?: MockKimaiClient;
  store?: InMemoryMappingStore;
  outbox?: InMemoryEventOutbox;
  upstreamSources?: { kimaiSha: string; opensignSha: string };
}

/**
 * Builds a real Express app via createApp, wired to a mock KimaiClient and
 * in-memory store/outbox. Returns the app plus the injected internals so
 * tests can assert against them.
 */
export function makeApp(opts: MakeAppOpts = {}): TestApp {
  const config = opts.config ?? makeTestConfig();
  const client = opts.client ?? makeMockKimaiClient();
  const store = opts.store ?? new InMemoryMappingStore();
  const outbox = opts.outbox ?? new InMemoryEventOutbox();
  const upstreamSources = opts.upstreamSources ?? {
    kimaiSha: '7c2ed4b07cca2e15b1ab4cc5947afdf899a76401',
    opensignSha: 'f72624fa26211fe00776453d99a67120a4f5e060',
  };

  const service = new KimaiService(client, store, outbox, {
    useConfidentialLabels: config.useConfidentialLabels,
    defaultActivityName: config.defaultActivityName,
    adminUsername: config.kimaiAdminUsername,
    adminApiToken: config.kimaiAdminApiToken,
  });

  const app = createApp({ config, kimaiService: service, upstreamSources });

  return { app, store, outbox, client, config, service };
}

// ─── Signed request helper ──────────────────────────────────────────────────

export interface SignedRequestOpts extends SignedHeadersOpts {
  /** Body as an object (will be JSON-stringified) or a raw string, or undefined. */
  bodyObj?: unknown;
}

/**
 * Issues a supertest request to the app with correct HMAC signing.
 * Returns the supertest Test (a thenable) so callers can await it.
 */
export function signedRequest(app: express.Application, opts: SignedRequestOpts): Test {
  const bodyStr =
    opts.body !== undefined ? opts.body :
    opts.bodyObj !== undefined ? JSON.stringify(opts.bodyObj) : undefined;

  const headers = makeSignedHeaders({
    method: opts.method,
    path: opts.path,
    body: bodyStr,
    firmId: opts.firmId,
    secret: opts.secret,
    userId: opts.userId,
    nonce: opts.nonce,
    timestamp: opts.timestamp,
    correlationId: opts.correlationId,
    idempotencyKey: opts.idempotencyKey,
    omitSignature: opts.omitSignature,
    badSignature: opts.badSignature,
  });

  const method = opts.method.toLowerCase();
  let r: Test;
  switch (method) {
    case 'get': r = request(app).get(opts.path); break;
    case 'post': r = request(app).post(opts.path); break;
    case 'patch': r = request(app).patch(opts.path); break;
    case 'delete': r = request(app).delete(opts.path); break;
    default: r = request(app).post(opts.path); break;
  }
  r = r.set(headers);
  if (bodyStr !== undefined) r = r.send(bodyStr);
  return r;
}

export { request };
