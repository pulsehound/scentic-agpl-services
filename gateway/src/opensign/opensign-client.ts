/**
 * OpenSign API client — wraps Parse Server REST API calls.
 *
 * Verified endpoints from vendor/opensign/ source:
 * - Parse REST: POST /functions/<name> for Cloud Functions
 * - Parse REST: GET/POST/PUT/DELETE /classes/<className> for direct CRUD
 * - Auth: X-Parse-Application-Id + X-Parse-Session-Token or X-Parse-Master-Key
 *
 * Security:
 * - Never logs document contents, signer emails, session tokens, or signing links
 * - Raw OpenSign errors are wrapped safely (never exposed to Scentic)
 * - All methods return typed OpenSignResult<T>
 */

import { createHash } from 'node:crypto';
import { wrapUpstreamError, notSupported } from '../http/errors.js';
import type { OpenSignResult, OpenSignDocument, OpenSignHealthStatus, OpenSignContact, OpenSignTenant, OpenSignUser } from './types.js';

export interface OpenSignClientConfig {
  baseUrl: string;
  appId: string;
  masterKey: string;
  adminEmail: string;
  adminPassword: string;
}

export class OpenSignClient {
  private config: OpenSignClientConfig;
  private sessionToken: string | null = null;

  constructor(config: OpenSignClientConfig) {
    this.config = config;
  }

  private headers(useMaster = false): Record<string, string> {
    const h: Record<string, string> = {
      'X-Parse-Application-Id': this.config.appId,
      'Content-Type': 'application/json',
    };
    if (useMaster) {
      h['X-Parse-Master-Key'] = this.config.masterKey;
    } else if (this.sessionToken) {
      h['X-Parse-Session-Token'] = this.sessionToken;
    }
    return h;
  }

  private async callFunction<T>(name: string, params: Record<string, unknown>, useMaster = false): Promise<OpenSignResult<T>> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/functions/${name}`, {
        method: 'POST',
        headers: this.headers(useMaster),
        body: JSON.stringify(params),
      });
      if (!resp.ok) {
        return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: `OpenSign function ${name} returned ${resp.status}` } };
      }
      const json = await resp.json() as { result?: T; error?: string; code?: number };
      if (json.error) {
        return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: `OpenSign function ${name} failed` } };
      }
      return { success: true, data: json.result };
    } catch (err) {
      return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: `OpenSign ${name} request failed` } };
    }
  }

  private async restCall<T>(method: string, path: string, body?: Record<string, unknown>, useMaster = true): Promise<OpenSignResult<T>> {
    try {
      const resp = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: this.headers(useMaster),
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!resp.ok) {
        return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: `OpenSign REST ${method} ${path} returned ${resp.status}` } };
      }
      const json = await resp.json() as T;
      return { success: true, data: json };
    } catch (err) {
      return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: `OpenSign REST ${method} ${path} request failed` } };
    }
  }

  setSessionToken(token: string): void {
    this.sessionToken = token;
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  // ── Health ────────────────────────────────────────────────────────────

  async getStatus(): Promise<OpenSignResult<OpenSignHealthStatus>> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/`, {
        method: 'GET',
        headers: this.headers(true),
      });
      if (!resp.ok) {
        return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: 'OpenSign server returned error status' } };
      }
      return { success: true, data: { reachable: true, appId: this.config.appId } };
    } catch {
      return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: 'OpenSign server is not reachable' } };
    }
  }

  // ── Authentication ────────────────────────────────────────────────────

  async login(email: string, password: string): Promise<OpenSignResult<{ sessionToken: string; objectId: string }>> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/login`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ username: email, password }),
      });
      if (!resp.ok) {
        return { success: false, error: { code: 'OPENSIGN_AUTH_FAILED', message: 'OpenSign login failed' } };
      }
      const json = await resp.json() as { sessionToken: string; objectId: string };
      this.sessionToken = json.sessionToken;
      return { success: true, data: json };
    } catch {
      return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: 'OpenSign login request failed' } };
    }
  }

  // ── Tenant operations ─────────────────────────────────────────────────

  async getTenant(tenantId: string): Promise<OpenSignResult<OpenSignTenant>> {
    return this.restCall<OpenSignTenant>('GET', `/classes/partners_Tenant/${tenantId}`, undefined, true);
  }

  async createTenant(name: string, email: string): Promise<OpenSignResult<OpenSignTenant>> {
    return this.restCall<OpenSignTenant>('POST', '/classes/partners_Tenant', {
      TenantName: name,
      EmailAddress: email,
      IsActive: true,
    }, true);
  }

  // ── User operations ───────────────────────────────────────────────────

  async getUserId(email: string): Promise<OpenSignResult<{ objectId: string }>> {
    return this.callFunction<{ objectId: string }>('getUserId', { email }, true);
  }

  async addUser(params: { name: string; email: string; password: string; role: string; tenantId: string }): Promise<OpenSignResult<{ objectId: string }>> {
    return this.callFunction<{ objectId: string }>('adduser', {
      name: params.name,
      email: params.email,
      password: params.password,
      role: params.role,
      tenantId: params.tenantId,
      organization: '',
      team: '',
    }, true);
  }

  // ── Document operations ───────────────────────────────────────────────

  async uploadFile(fileBase64: string, fileName: string): Promise<OpenSignResult<{ url: string }>> {
    return this.callFunction<{ url: string }>('savefile', { fileBase64, fileName }, true);
  }

  async createDocument(params: {
    name: string;
    url: string;
    extUserPtr: { objectId: string; __type: string; className: string };
    signers: Array<{ objectId: string; __type: string; className: string }>;
    placeholders: unknown[];
    timeToCompleteDays?: number;
    sendinOrder?: boolean;
    isEnableOTP?: boolean;
    notifyOnSignatures?: boolean;
  }): Promise<OpenSignResult<{ objectId: string }>> {
    return this.callFunction<{ objectId: string }>('createdocumentfromapp', {
      document: {
        Name: params.name,
        URL: params.url,
        Type: '',
        ExtUserPtr: params.extUserPtr,
        Signers: params.signers,
        Placeholders: params.placeholders,
        TimeToCompleteDays: params.timeToCompleteDays ?? 15,
        SendinOrder: params.sendinOrder ?? false,
        IsEnableOTP: params.isEnableOTP ?? false,
        NotifyOnSignatures: params.notifyOnSignatures ?? true,
        AutomaticReminders: true,
        RemindOnceInEvery: 5,
      },
    }, true);
  }

  async getDocument(docId: string): Promise<OpenSignResult<OpenSignDocument>> {
    return this.callFunction<OpenSignDocument>('getDocument', { docId }, true);
  }

  async linkContactToDoc(params: {
    docId: string;
    email: string;
    name?: string;
    phone?: string;
    jobTitle?: string;
    company?: string;
  }): Promise<OpenSignResult<{ objectId: string }>> {
    return this.callFunction<{ objectId: string }>('linkcontacttodoc', params, true);
  }

  async declineDocument(params: { docId: string; userId: string; reason?: string }): Promise<OpenSignResult<boolean>> {
    return this.callFunction<boolean>('declinedoc', params, true);
  }

  async getSignedUrl(params: { docId?: string; url: string }): Promise<OpenSignResult<{ url: string }>> {
    return this.callFunction<{ url: string }>('getsignedurl', params, true);
  }

  async generateCertificate(docId: string): Promise<OpenSignResult<{ url: string }>> {
    return this.callFunction<{ url: string }>('generatecertificate', { docId }, true);
  }

  // ── Unsupported operations ────────────────────────────────────────────
  // OpenSign has no native "void/cancel" API. Decline is the closest.
  // OpenSign has no native "send reminder" API. Automatic reminders are configured per-doc.
  // OpenSign has no native "delegate signer" API via Cloud Functions.

  async cancelDocument(docId: string, userId: string, reason: string): Promise<OpenSignResult<boolean>> {
    // OpenSign does not have a "void" or "cancel" function.
    // The closest is `declinedoc`, but that marks the document as declined by a user,
    // not cancelled by the sender. We use it as the best available option.
    return this.declineDocument({ docId, userId, reason });
  }

  async sendReminder(_docId: string, _signerEmail: string): Promise<OpenSignResult<boolean>> {
    // OpenSign has no dedicated "send reminder" Cloud Function.
    // Automatic reminders are configured per-document via `AutomaticReminders` + `RemindOnceInEvery`.
    // Manual reminders would require calling `sendmailv3` directly, which is not a stable API.
    return { success: false, error: { code: 'NOT_SUPPORTED', message: 'OpenSign does not support manual reminders via API. Automatic reminders are configured per-document.' } };
  }
}
