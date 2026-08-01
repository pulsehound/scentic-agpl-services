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
  /** The admin's _User id, from login. Documents are created by somebody. */
  private adminUserId: string | null = null;
  /** The admin's contracts_Users id. OpenSign's own user record, not the Parse one. */
  private adminExtUserId: string | null = null;

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

  /**
   * A logged-in administrator session, established on demand.
   *
   * The admin credentials were configured and never used to authenticate
   * anything: the only login in the stack happened while syncing a user, whose
   * session was stored against that user and not available to document
   * operations.
   */
  private async ensureAdminSession(): Promise<OpenSignResult<{ sessionToken: string }>> {
    if (this.sessionToken) return { success: true, data: { sessionToken: this.sessionToken } };

    const first = await this.login(this.config.adminEmail, this.config.adminPassword);
    if (first.success) {
      this.adminUserId = first.data!.objectId;
      await this.loadAdminExtUser();
      return { success: true, data: { sessionToken: first.data!.sessionToken } };
    }

    // No administrator yet. A freshly provisioned OpenSign has an empty
    // database and no way in: adduser and every other user function require an
    // authenticated admin, so the first one cannot be made through them. That
    // deadlock is normally broken by a human at the sign-up page, which a stack
    // meant to be rebuilt from its configuration cannot rely on.
    const bootstrap = await this.createFirstAdmin();
    if (!bootstrap.success) return { success: false, error: bootstrap.error };

    const second = await this.login(this.config.adminEmail, this.config.adminPassword);
    if (!second.success) return { success: false, error: second.error };
    this.adminUserId = second.data!.objectId;
    await this.loadAdminExtUser();
    return { success: true, data: { sessionToken: second.data!.sessionToken } };
  }

  /**
   * Find the admin's contracts_Users record.
   *
   * OpenSign keeps its own user row alongside Parse's _User and the two are not
   * interchangeable: a document's ExtUserPtr points at contracts_Users while
   * CreatedBy points at _User. Sending the same id for both is accepted by
   * Parse and produces a document belonging to nobody.
   */
  private async loadAdminExtUser(): Promise<void> {
    if (!this.adminUserId) return;
    const where = encodeURIComponent(
      JSON.stringify({ UserId: { __type: 'Pointer', className: '_User', objectId: this.adminUserId } }),
    );
    const result = await this.restCall<{ results?: Array<{ objectId: string }> }>(
      'GET',
      `/classes/contracts_Users?where=${where}`,
      undefined,
      true,
    );
    this.adminExtUserId = result.success ? result.data?.results?.[0]?.objectId ?? null : null;
  }

  /**
   * Create the very first administrator.
   *
   * addadmin is the only user-creating function that does not itself require a
   * session, and it takes its fields nested under `userDetails` — passed flat
   * it fails with "Cannot read properties of undefined (reading 'email')",
   * which looks like a missing field rather than a wrongly shaped payload.
   *
   * Called only after a login attempt has failed, so an existing installation
   * is never touched.
   */
  private async createFirstAdmin(): Promise<OpenSignResult<unknown>> {
    return this.callFunction<unknown>(
      'addadmin',
      {
        userDetails: {
          name: 'Scentic Integration',
          email: this.config.adminEmail,
          password: this.config.adminPassword,
          phone: '',
          company: 'Scentic',
          jobTitle: 'Integration',
          role: 'contracts_Admin',
        },
      },
      true,
    );
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

  /**
   * Put the document bytes into OpenSign's own storage.
   *
   * Uses a *session*, not the master key. OpenSign's savefile cloud function
   * reads request.user, and the master key does not populate it — Parse treats
   * a master-key call as privileged but userless, so the function answers
   * "User is not authenticated" (code 209) no matter how correct the key is.
   * That reads as a bad master key when the master key was never the problem.
   *
   * Retried once on failure with a fresh login. Sessions expire, and a
   * signature request refused hours later because a token aged out would look
   * like an intermittent fault in the signing service.
   */
  async uploadFile(fileBase64: string, fileName: string): Promise<OpenSignResult<{ url: string }>> {
    const session = await this.ensureAdminSession();
    if (!session.success) return { success: false, error: session.error };

    // Storage name only. The name a person reads is set on the document record,
    // so nothing legible is lost by making this one boring.
    const storedName = storageSafeFilename(fileName);

    const first = await this.callFunction<{ url: string }>('savefile', { fileBase64, fileName: storedName }, false);
    if (first.success) return first;

    this.sessionToken = null;
    const retry = await this.ensureAdminSession();
    if (!retry.success) return first;

    return this.callFunction<{ url: string }>('savefile', { fileBase64, fileName: storedName }, false);
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
    const session = await this.ensureAdminSession();
    if (!session.success) return { success: false, error: session.error };

    // The caller's pointer when it names somebody, the admin's otherwise. A
    // pointer with an empty objectId — which is what the caller sends when no
    // signer has been synced — is not a null pointer, it is a broken one, and
    // Parse rejects the save with a 400 that names nothing.
    const extUserPtr =
      params.extUserPtr.objectId
        ? params.extUserPtr
        : { objectId: this.adminExtUserId ?? '', __type: 'Pointer', className: 'contracts_Users' };

    const created = await this.callFunction<{ objectId: string }>('createdocumentfromapp', {
      document: {
        Name: params.name,
        URL: params.url,
        Type: '',
        ExtUserPtr: extUserPtr,
        // Read by createDocumentFromApp and never sent. Without it the document
        // is saved with no creator, which OpenSign refuses.
        CreatedBy: { objectId: this.adminUserId ?? '', __type: 'Pointer', className: '_User' },
        Signers: params.signers,
        Placeholders: params.placeholders,
        TimeToCompleteDays: params.timeToCompleteDays ?? 15,
        SendinOrder: params.sendinOrder ?? false,
        IsEnableOTP: params.isEnableOTP ?? false,
        NotifyOnSignatures: params.notifyOnSignatures ?? true,
        AutomaticReminders: true,
        RemindOnceInEvery: 5,
      },
      // Session, not master key. createDocumentFromApp requires request.user,
      // and a master-key call is privileged but userless — the same trap as
      // savefile, answered with 209 rather than anything about the document.
    }, false);

    if (!created.success) return created;

    // createDocumentFromApp saves no ACL, and linkContactToDoc calls
    // docRes.getACL().setReadAccess() unconditionally. On a document created
    // through the app flow that is null, and the resulting TypeError is caught
    // and discarded inside linkContactToDoc — which then returns undefined
    // rather than failing. The two upstream functions cannot be used together
    // until one exists, so it is written here.
    await this.setDocumentAcl(created.data!.objectId);
    return created;
  }

  /**
   * The document ACL the signing flow expects to find.
   *
   * Only the creator, at this point. linkContactToDoc widens it to each signer
   * as they are attached, which is what it was reaching for when it found null.
   */
  private async setDocumentAcl(docId: string): Promise<void> {
    if (!this.adminUserId) return;
    await this.restCall(
      'PUT',
      `/classes/contracts_Document/${docId}`,
      { ACL: { [this.adminUserId]: { read: true, write: true } } },
      true,
    );
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
    const session = await this.ensureAdminSession();
    if (!session.success) return { success: false, error: session.error };

    const result = await this.callFunction<{ contactId?: string }>('linkcontacttodoc', params, false);
    if (!result.success) return { success: false, error: result.error };

    // Two things upstream does that the caller cannot see. It answers with
    // `contactId`, not `objectId`. And when contact creation throws it catches
    // the error, logs it, and returns nothing — so a 200 with an empty body is
    // a failure, not a success with a missing field. Reading .objectId off that
    // undefined was the crash this replaces.
    const contactId = result.data?.contactId;
    if (!contactId) {
      return {
        success: false,
        error: {
          code: 'OPENSIGN_API_ERROR',
          message: 'OpenSign linked no contact for this signer',
        },
      };
    }

    return { success: true, data: { objectId: contactId } };
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

/**
 * A filename Parse will accept.
 *
 * Parse rejects anything outside a narrow ASCII set with "Filename contains
 * invalid characters", and a legal system in Israel names documents in Hebrew —
 * so the common case is a filename with not one acceptable character in it.
 * Latin-accented names collapse to their base letters; scripts that have no
 * ASCII equivalent leave nothing behind, and there is no honest transliteration
 * to invent, so those become a generic name.
 *
 * This is deliberately not a round trip. The readable title is carried on the
 * document record and is what signers see; this string exists only so the bytes
 * have somewhere to live.
 */
export function storageSafeFilename(original: string): string {
  const lastDot = original.lastIndexOf('.');
  const hasExt = lastDot > 0 && lastDot < original.length - 1;

  // NFKD splits accented Latin into letter + mark, so the marks can be dropped
  // and the letter kept. It does nothing for Hebrew, Arabic or CJK, which is
  // why the fallback below has to exist.
  const reduce = (part: string) =>
    part
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '');

  const stem = reduce(hasExt ? original.slice(0, lastDot) : original).slice(0, 80);
  const ext = (hasExt ? reduce(original.slice(lastDot + 1)) : '').toLowerCase();

  // Parse also requires the first character to be alphanumeric or an
  // underscore, which a name beginning with a digit satisfies and one beginning
  // with a dash does not.
  const base = /^[A-Za-z0-9_]/.test(stem) ? stem : `document${stem ? `-${stem}` : ''}`;

  return ext ? `${base}.${ext}` : `${base}.pdf`;
}
