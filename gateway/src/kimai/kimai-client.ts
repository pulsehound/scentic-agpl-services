/**
 * Kimai REST API client.
 *
 * Verified endpoints from Kimai source inspection (config/routes.yaml, src/API/):
 * - GET /api/status — system status (version, info)
 * - GET/POST /api/timesheets — list/create timesheets
 * - GET/PATCH/DELETE /api/timesheets/{id} — get/update/delete timesheet
 * - GET/POST /api/customers — list/create customers
 * - GET/POST /api/projects — list/create projects
 * - GET/POST /api/activities — list/create activities
 * - GET/POST /api/users — list/create users (SUPER_ADMIN required for create)
 * - GET/POST /api/teams — list/create teams
 * - POST /api/export — export timesheets
 *
 * Auth: selected by KIMAI_AUTH_MODE.
 *
 *   bearer   Authorization: Bearer <token>. Kimai access tokens, newer builds.
 *   legacy   X-AUTH-USER + X-AUTH-TOKEN. The API password from a user's
 *            profile page, which is what Kimai 2.30 issues.
 *
 * This mattered in practice rather than in theory: against Kimai 2.30 a Bearer
 * request is answered 401 and the same token in X-AUTH headers is answered 200.
 * Sending only Bearer made the gateway unable to reach Kimai at all, and the
 * failure looks like a bad token rather than a wrong scheme.
 *
 * Defaults to legacy because that is what the deployed Kimai accepts.
 *
 * Security:
 * - Never log request/response bodies (may contain confidential descriptions)
 * - Wrap all upstream errors safely
 * - Timeout all requests
 */

import { wrapUpstreamError, upstreamUnavailable, type GatewayError } from '../http/errors.js';
import { getIdentityToken, audienceFor } from '../gcp/identity-token.js';

export interface KimaiClientConfig {
  baseUrl: string;
  apiToken: string;
  username: string;
  timeoutMs?: number;
  /** Which authentication scheme Kimai expects. See the note above. */
  authMode?: 'bearer' | 'legacy';
}

export interface KimaiCustomer {
  id: number;
  name: string;
  number?: string;
  visible: boolean;
  team?: number;
}

export interface KimaiProject {
  id: number;
  name: string;
  customer: number;
  visible: boolean;
  orderNumber?: string;
}

export interface KimaiActivity {
  id: number;
  name: string;
  project?: number;
  visible: boolean;
}

export interface KimaiUser {
  id: number;
  username: string;
  email: string;
  firstname?: string;
  lastname?: string;
  enabled: boolean;
}

export interface KimaiTeam {
  id: number;
  name: string;
  teamlead?: number;
}

export interface KimaiTimesheet {
  id: number;
  begin: string;
  end?: string;
  duration?: number;
  activity: number;
  project: number;
  user: number;
  description?: string;
  exported?: boolean;
}

export interface KimaiStatus {
  version: string;
  versionId?: number;
}

type KimaiResult<T> = { success: true; data: T } | { success: false; error: GatewayError };

export class KimaiClient {
  private config: KimaiClientConfig;
  private token: string;

  constructor(config: KimaiClientConfig) {
    this.config = config;
    this.token = config.apiToken;
  }

  setToken(token: string): void {
    this.token = token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    tokenOverride?: string,
  ): Promise<KimaiResult<T>> {
    const url = `${this.config.baseUrl}${path}`;
    const token = tokenOverride ?? this.token;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30_000);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      if ((this.config.authMode ?? 'legacy') === 'bearer') {
        headers['Authorization'] = `Bearer ${token}`;
      } else {
        // The username is part of the credential in this scheme, not just the
        // token, so it has to travel with every request.
        headers['X-AUTH-USER'] = this.config.username;
        headers['X-AUTH-TOKEN'] = token;
      }

      // Two authentications, two consumers, and they cannot share a header.
      //
      // Cloud Run's IAM check runs in front of Kimai and wants a Google identity
      // token; Kimai wants its own credentials. Putting the Google token in
      // Authorization satisfies Cloud Run and then breaks Kimai, whose
      // TokenAuthenticator sees an Authorization header, tries to read it as a
      // Kimai token, and answers 401 without ever looking at X-AUTH-USER — a
      // failure that reads as a bad Kimai token when the Kimai token was never
      // consulted.
      //
      // X-Serverless-Authorization exists for exactly this. Cloud Run accepts
      // the identity token there and leaves Authorization untouched for the
      // application behind it, so both checks are satisfied and neither sees
      // the other's credential. It also means this is safe in *both* auth
      // modes, including bearer, where Kimai's own token owns Authorization.
      const identityToken = await getIdentityToken(audienceFor(this.config.baseUrl));
      if (identityToken) headers['X-Serverless-Authorization'] = `Bearer ${identityToken}`;

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        // Never expose raw upstream error body
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: wrapUpstreamError('Kimai', `${method} ${path}`, 'auth failed') };
        }
        if (response.status === 404) {
          return { success: false, error: wrapUpstreamError('Kimai', `${method} ${path}`, 'not found') };
        }
        if (response.status >= 500) {
          return { success: false, error: upstreamUnavailable(`Kimai ${method} ${path} returned ${response.status}`) };
        }
        return { success: false, error: wrapUpstreamError('Kimai', `${method} ${path}`, `status ${response.status}`) };
      }

      const data = await response.json() as T;
      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('aborted')) {
        return { success: false, error: upstreamUnavailable(`Kimai ${method} ${path} timed out`) };
      }
      return { success: false, error: upstreamUnavailable(`Kimai ${method} ${path} failed: connection error`) };
    }
  }

  // ── Status / Health ───────────────────────────────────────────────────

  async getStatus(): Promise<KimaiResult<KimaiStatus>> {
    return this.request<KimaiStatus>('GET', '/api/status');
  }

  // ── Teams ─────────────────────────────────────────────────────────────

  async listTeams(): Promise<KimaiResult<KimaiTeam[]>> {
    return this.request<KimaiTeam[]>('GET', '/api/teams');
  }

  async createTeam(name: string): Promise<KimaiResult<KimaiTeam>> {
    return this.request<KimaiTeam>('POST', '/api/teams', { name });
  }

  // ── Users ─────────────────────────────────────────────────────────────

  async listUsers(): Promise<KimaiResult<KimaiUser[]>> {
    return this.request<KimaiUser[]>('GET', '/api/users');
  }

  async createUser(params: {
    username: string;
    email: string;
    firstname?: string;
    lastname?: string;
    password?: string;
  }): Promise<KimaiResult<KimaiUser>> {
    return this.request<KimaiUser>('POST', '/api/users', params);
  }

  async updateUser(id: number, params: Partial<{
    email: string;
    firstname: string;
    lastname: string;
    enabled: boolean;
  }>): Promise<KimaiResult<KimaiUser>> {
    return this.request<KimaiUser>('PATCH', `/api/users/${id}`, params);
  }

  // ── Customers ─────────────────────────────────────────────────────────

  async listCustomers(teamId?: number): Promise<KimaiResult<KimaiCustomer[]>> {
    const query = teamId ? `?team=${teamId}` : '';
    return this.request<KimaiCustomer[]>('GET', `/api/customers${query}`);
  }

  async createCustomer(params: {
    name: string;
    number?: string;
    visible?: boolean;
    team?: number;
  }): Promise<KimaiResult<KimaiCustomer>> {
    return this.request<KimaiCustomer>('POST', '/api/customers', {
      name: params.name,
      number: params.number,
      visible: params.visible ?? true,
      team: params.team,
    });
  }

  // ── Projects ──────────────────────────────────────────────────────────

  async listProjects(customerId?: number, teamId?: number): Promise<KimaiResult<KimaiProject[]>> {
    const params = new URLSearchParams();
    if (customerId) params.set('customer', String(customerId));
    if (teamId) params.set('team', String(teamId));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<KimaiProject[]>('GET', `/api/projects${query}`);
  }

  async createProject(params: {
    name: string;
    customer: number;
    visible?: boolean;
    orderNumber?: string;
    team?: number;
  }): Promise<KimaiResult<KimaiProject>> {
    return this.request<KimaiProject>('POST', '/api/projects', {
      name: params.name,
      customer: params.customer,
      visible: params.visible ?? true,
      orderNumber: params.orderNumber,
      team: params.team,
    });
  }

  // ── Activities ────────────────────────────────────────────────────────

  async listActivities(projectId?: number): Promise<KimaiResult<KimaiActivity[]>> {
    const query = projectId ? `?project=${projectId}` : '';
    return this.request<KimaiActivity[]>('GET', `/api/activities${query}`);
  }

  async createActivity(params: {
    name: string;
    project?: number;
    visible?: boolean;
  }): Promise<KimaiResult<KimaiActivity>> {
    return this.request<KimaiActivity>('POST', '/api/activities', {
      name: params.name,
      project: params.project,
      visible: params.visible ?? true,
    });
  }

  // ── Timesheets ────────────────────────────────────────────────────────

  async listTimesheets(params: {
    user?: number;
    project?: number;
    begin?: string;
    end?: string;
    size?: number;
    page?: number;
  }): Promise<KimaiResult<KimaiTimesheet[]>> {
    const qs = new URLSearchParams();
    if (params.user) qs.set('user', String(params.user));
    if (params.project) qs.set('project', String(params.project));
    if (params.begin) qs.set('begin', params.begin);
    if (params.end) qs.set('end', params.end);
    if (params.size) qs.set('size', String(params.size));
    if (params.page) qs.set('page', String(params.page));
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<KimaiTimesheet[]>('GET', `/api/timesheets${query}`);
  }

  async createTimesheet(params: {
    begin: string;
    end?: string;
    duration?: number;
    activity: number;
    project: number;
    user: number;
    description?: string;
  }, tokenOverride?: string): Promise<KimaiResult<KimaiTimesheet>> {
    return this.request<KimaiTimesheet>('POST', '/api/timesheets', params, tokenOverride);
  }

  async getTimesheet(id: number): Promise<KimaiResult<KimaiTimesheet>> {
    return this.request<KimaiTimesheet>('GET', `/api/timesheets/${id}`);
  }

  async updateTimesheet(id: number, params: Partial<{
    begin: string;
    end: string;
    duration: number;
    description: string;
    exported: boolean;
  }>): Promise<KimaiResult<KimaiTimesheet>> {
    return this.request<KimaiTimesheet>('PATCH', `/api/timesheets/${id}`, params);
  }

  async deleteTimesheet(id: number): Promise<KimaiResult<void>> {
    return this.request<void>('DELETE', `/api/timesheets/${id}`);
  }

  // ── Export ────────────────────────────────────────────────────────────

  async exportTimesheets(params: {
    format?: string;
    begin?: string;
    end?: string;
    user?: number[];
    project?: number[];
  }): Promise<KimaiResult<{ url?: string; content?: string }>> {
    // Kimai export endpoint may return a file URL or binary content
    // The exact API shape needs verification against the Kimai version
    return this.request<{ url?: string; content?: string }>('POST', '/api/export', params);
  }
}
