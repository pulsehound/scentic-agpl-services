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

/** A Parse ACL as REST reads and writes it: user id (or "*") to its permissions. */
export type DocumentAcl = Record<string, { read?: boolean; write?: boolean }>;

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
      // Parse Server's own health route under its mount path. The mount path itself answers 404,
      // so asking for it reported a running server as unreachable on every check.
      const resp = await fetch(`${this.config.baseUrl}/health`, {
        method: 'GET',
        headers: this.headers(true),
        signal: AbortSignal.timeout(20_000),
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
    /**
     * Signers open the document only after entering a code emailed to them. On unless a caller
     * turns it off: without it OpenSign hands the document to anyone who has its id, and the id is
     * in every signing link — a forwarded invitation, or the old link of somebody replaced.
     */
    isEnableOTP?: boolean;
    notifyOnSignatures?: boolean;
    redirectUrl?: string;
    /**
     * The wording OpenSign uses when it, rather than the gateway, invites somebody — the next
     * signer of a document signed in order. Variables in OpenSign's own syntax.
     */
    requestSubject?: string;
    requestBody?: string;
    senderName?: string;
    /** The firm the request comes from, named in the code email (deploy/opensign-server-files). */
    firmName?: string;
    /** OpenSign's own reminder mail every few days. Off where Scentic chases signers itself. */
    automaticReminders?: boolean;
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
        // Strict as well: in order means a later signer cannot sign first by finding the link.
        SendInOrderStrict: params.sendinOrder ?? false,
        ...(params.redirectUrl ? { RedirectUrl: params.redirectUrl } : {}),
        IsEnableOTP: params.isEnableOTP ?? true,
        NotifyOnSignatures: params.notifyOnSignatures ?? true,
        AutomaticReminders: params.automaticReminders ?? true,
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
    await this.setDocumentAcl(created.data!.objectId, {
      // Not read by createDocumentFromApp, so set afterwards.
      ...(params.requestSubject ? { RequestSubject: params.requestSubject } : {}),
      ...(params.requestBody ? { RequestBody: params.requestBody } : {}),
      ...(params.senderName ? { SenderName: params.senderName } : {}),
      ...(params.firmName ? { FirmName: params.firmName } : {}),
    });
    return created;
  }

  /**
   * The document's ACL as it stands, and as it would be without the person behind one contact.
   *
   * linkcontacttodoc gives each signer's account read and write access to the document, and
   * nothing takes it away again. With email codes on, that access is what opens the document: a
   * signer who was replaced, or who handed over, could still enter a code sent to their own
   * address and read it. The platform's own account keeps its access whoever the contact is.
   */
  async documentAccessWithout(docId: string, contactId: string): Promise<OpenSignResult<{ before: DocumentAcl; after: DocumentAcl }>> {
    const session = await this.ensureAdminSession();
    if (!session.success) return { success: false, error: session.error };

    const doc = await this.restCall<{ ACL?: DocumentAcl }>('GET', `/classes/contracts_Document/${docId}`, undefined, true);
    if (!doc.success) return { success: false, error: doc.error };
    const contact = await this.restCall<{ UserId?: { objectId?: string } }>('GET', `/classes/contracts_Contactbook/${contactId}`, undefined, true);
    if (!contact.success) return { success: false, error: contact.error };

    const before = doc.data?.ACL ?? {};
    const after = { ...before };
    const userId = contact.data?.UserId?.objectId;
    if (userId && userId !== this.adminUserId) delete after[userId];
    return { success: true, data: { before, after } };
  }

  /**
   * The document ACL the signing flow expects to find.
   *
   * Only the creator, at this point. linkContactToDoc widens it to each signer
   * as they are attached, which is what it was reaching for when it found null.
   */
  private async setDocumentAcl(docId: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.adminUserId) {
      if (Object.keys(extra).length > 0) {
        await this.restCall('PUT', `/classes/contracts_Document/${docId}`, extra, true);
      }
      return;
    }
    await this.restCall(
      'PUT',
      `/classes/contracts_Document/${docId}`,
      { ACL: { [this.adminUserId]: { read: true, write: true } }, ...extra },
      true,
    );
  }

  /**
   * The bytes of one of a document's files — the signed PDF or the certificate.
   *
   * OpenSign serves stored files only through links signed for a few minutes, so a fresh one is
   * asked for each time rather than the stored address being fetched.
   */
  async fetchDocumentFile(docId: string, storedUrl: string): Promise<OpenSignResult<Buffer>> {
    const signed = await this.callFunction<string | { url?: string }>('getsignedurl', { docId, url: storedUrl }, true);
    if (!signed.success) return { success: false, error: signed.error };
    const url = typeof signed.data === 'string' ? signed.data : signed.data?.url;
    if (!url) {
      return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: 'OpenSign gave no address for the file' } };
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: `OpenSign file fetch returned ${resp.status}` } };
      }
      return { success: true, data: Buffer.from(await resp.arrayBuffer()) };
    } catch {
      return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: 'OpenSign file could not be fetched' } };
    }
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

  /**
   * Tell a signer there is something waiting for them.
   *
   * Composed here rather than delegated. OpenSign builds this mail inside its
   * own send flows, which are not reachable as an API — so a document created
   * through the integration is created, linked, and then sits there silently.
   * `sendNow` was accepted and carried through every layer without anything
   * ever acting on it.
   *
   * The wording is deliberately plain. This arrives at a counterparty who has
   * no account and no relationship with the software, and it should read as a
   * message from the firm rather than from a product.
   */
  async sendSigningInvitation(params: SigningMailParams): Promise<OpenSignResult<unknown>> {
    return this.sendSigningMail(params, 'invitation');
  }

  /**
   * Ask again.
   *
   * The same message with different wording and the same link — because that is
   * what a reminder is, and re-issuing the link would invalidate the one already
   * sitting in their inbox.
   *
   * This used to refuse. The note said manual reminders would mean calling
   * sendmailv3 directly and that this was not a stable API, but the invitation
   * above already calls sendmailv3 directly and has been delivering mail in
   * production since it was written. The refusal was costing the firm the one
   * thing it most often needs to do with an unsigned document.
   *
   * Not to be confused with OpenSign's own AutomaticReminders, which are set
   * per document at creation and cannot be aimed at one person or stopped
   * afterwards. Scentic decides who is chased and when; this only delivers.
   */
  async sendSigningReminder(params: SigningMailParams): Promise<OpenSignResult<unknown>> {
    return this.sendSigningMail(params, 'reminder');
  }

  private async sendSigningMail(
    params: SigningMailParams,
    kind: 'invitation' | 'reminder',
  ): Promise<OpenSignResult<unknown>> {
    const link = signingUrlFor(params.publicUrl, params.docId, params.recipientEmail, params.contactId);
    const { subject, html } = signingMail({
      kind,
      senderName: params.senderName,
      documentName: params.documentName,
      recipientName: params.recipientName,
      link,
      subject: params.subject,
      message: params.message,
      expiresAt: params.expiresAt,
    });

    return this.callFunction<unknown>(
      'sendmailv3',
      {
        extUserId: params.extUserId,
        recipient: params.recipientEmail,
        subject,
        from: params.senderName,
        html,
      },
      true,
    );
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

  // ── The signing ceremony Scentic hosts ────────────────────────────────
  //
  // Scentic authenticates the signer itself, shows the document, and stamps the signer's fields
  // onto the PDF on its own server. What reaches here is the finished page set, submitted to
  // OpenSign *as that signer* so OpenSign still orders, seals and certifies it. Each call below is
  // made with the signer's own session — the patched server binds a signature and a refusal to the
  // signed-in account (deploy/opensign-server-patches.mjs) — and names the signer's address as the
  // first X-Forwarded-For entry, which is where OpenSign reads the address it writes in its audit
  // trail (vendor index.js getUserIP). Without it the trail would name this gateway.
  //
  // A session token is never logged, returned to a caller, or kept: it is asked for, used for one
  // call and dropped.

  /** The Parse account behind a signer's contact. */
  async getContactUserId(contactId: string): Promise<OpenSignResult<string>> {
    const contact = await this.restCall<{ UserId?: { objectId?: string } }>(
      'GET',
      `/classes/contracts_Contactbook/${encodeURIComponent(contactId)}`,
      undefined,
      true,
    );
    if (!contact.success) return { success: false, error: contact.error };
    const userId = contact.data?.UserId?.objectId;
    if (!userId) return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: 'OpenSign contact has no account' } };
    return { success: true, data: userId };
  }

  /**
   * A session for one signer's account, by Parse's /loginAs with the master key — the same call the
   * server's own code sign-in makes (deploy/opensign-server-files/AuthLoginAsMail.js). No password
   * is involved; signers' accounts have none anybody knows.
   */
  async signerSession(userId: string): Promise<OpenSignResult<{ sessionToken: string }>> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/loginAs`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ userId }),
      });
      if (!resp.ok) {
        return { success: false, error: { code: 'OPENSIGN_AUTH_FAILED', message: `OpenSign loginAs returned ${resp.status}` } };
      }
      const json = await resp.json() as { sessionToken?: string };
      if (!json.sessionToken) {
        return { success: false, error: { code: 'OPENSIGN_AUTH_FAILED', message: 'OpenSign loginAs gave no session' } };
      }
      return { success: true, data: { sessionToken: json.sessionToken } };
    } catch {
      return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: 'OpenSign loginAs request failed' } };
    }
  }

  /** A cloud function called as one signer, from that signer's address. */
  private async callFunctionAs<T>(
    name: string,
    params: Record<string, unknown>,
    as: { sessionToken: string; ipAddress: string },
  ): Promise<OpenSignResult<T>> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/functions/${name}`, {
        method: 'POST',
        headers: {
          'X-Parse-Application-Id': this.config.appId,
          'Content-Type': 'application/json',
          'X-Parse-Session-Token': as.sessionToken,
          // triggerevent and getDocument read the session from this header, not Parse's own.
          sessiontoken: as.sessionToken,
          'X-Forwarded-For': forwardedFor(as.ipAddress),
        },
        body: JSON.stringify(params),
      });
      if (!resp.ok) {
        // Parse answers a refused cloud function with { code, error }. The number is kept — it is
        // how "not your turn" is told from "not found" — the text is not: it may name the signer.
        let upstreamCode: number | undefined;
        try {
          const body = await resp.json() as { code?: unknown };
          if (typeof body?.code === 'number') upstreamCode = body.code;
        } catch { /* no body */ }
        return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: `OpenSign function ${name} returned ${resp.status}`, upstreamCode } };
      }
      const json = await resp.json() as { result?: T; error?: string };
      if (json.error) {
        return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: `OpenSign function ${name} failed` } };
      }
      return { success: true, data: json.result };
    } catch {
      return { success: false, error: { code: 'OPENSIGN_UNREACHABLE', message: `OpenSign ${name} request failed` } };
    }
  }

  /** OpenSign's own "Viewed" audit entry for one signer. */
  async recordViewed(params: { docId: string; contactId: string; sessionToken: string; ipAddress: string }): Promise<OpenSignResult<true>> {
    const result = await this.callFunctionAs<{ message?: string }>(
      'triggerevent',
      { event: 'viewed', contactId: params.contactId, body: { objectId: params.docId } },
      { sessionToken: params.sessionToken, ipAddress: params.ipAddress },
    );
    if (!result.success) return { success: false, error: result.error };
    // triggerevent answers 200 whatever happened and says which in words.
    if (result.data?.message !== 'event called!') {
      return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: 'OpenSign did not record the event' } };
    }
    return { success: true, data: true };
  }

  /**
   * Submit a signer's stamped PDF: OpenSign's signPdf, as that signer. OpenSign stores the PDF as
   * the document's current file, writes the "Signed" audit entry with the signature image, and —
   * when this was the last signature — seals the document and makes its certificate.
   */
  async signAsSigner(params: {
    docId: string;
    contactId: string;
    pdfBase64: string;
    signaturePngBase64: string;
    sessionToken: string;
    ipAddress: string;
  }): Promise<OpenSignResult<{ url: string }>> {
    const result = await this.callFunctionAs<{ status?: string; data?: string }>(
      'signPdf',
      {
        pdfFile: params.pdfBase64,
        docId: params.docId,
        userId: params.contactId,
        signature: params.signaturePngBase64,
        isCustomCompletionMail: false,
      },
      { sessionToken: params.sessionToken, ipAddress: params.ipAddress },
    );
    if (!result.success) return { success: false, error: result.error };
    if (result.data?.status !== 'success') {
      return { success: false, error: { code: 'OPENSIGN_API_ERROR', message: 'OpenSign did not accept the signature' } };
    }
    return { success: true, data: { url: result.data.data ?? '' } };
  }

  /** A signer refuses the document: OpenSign's declinedoc, as that signer. */
  async declineAsSigner(params: {
    docId: string;
    userId: string;
    reason: string;
    sessionToken: string;
    ipAddress: string;
  }): Promise<OpenSignResult<true>> {
    const result = await this.callFunctionAs<string>(
      'declinedoc',
      { docId: params.docId, reason: params.reason, userId: params.userId },
      { sessionToken: params.sessionToken, ipAddress: params.ipAddress },
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: true };
  }

  // ── Unsupported operations ────────────────────────────────────────────
  // OpenSign has no native "void/cancel" API. Decline is the closest.
  // OpenSign has no native "delegate signer" API via Cloud Functions.
  //
  // Reminders were listed here and are not unsupported: see sendSigningReminder
  // above, which sends the same mail as the invitation with different wording.

  /**
   * Withdraw a document: archive it, which is how OpenSign's own sender revokes one.
   *
   * This used to call `declinedoc` with no user, which builds a pointer to an empty id; the save
   * failed and every cancellation came back as an upstream error, so nothing could ever be
   * cancelled. An archived document is refused to signers and reads as VOIDED in a status check;
   * the sender's reason is kept on the document beside it.
   */
  async cancelDocument(docId: string, _userId: string, reason: string): Promise<OpenSignResult<boolean>> {
    const result = await this.restCall<unknown>(
      'PUT',
      `/classes/contracts_Document/${docId}`,
      { IsArchive: true, ...(reason ? { DeclineReason: reason.slice(0, 500) } : {}) },
      true,
    );
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: true };
  }

  /**
   * Write fields on a document directly — its placeholders, signers, audit trail, signed copy.
   *
   * OpenSign has no function for changing who signs a document already sent, or for taking a
   * signature back; its own screens do neither. Both are a matter of setting the same fields its
   * signing flow sets, which is what this does. A field given as `null` is removed.
   */
  async updateDocument(docId: string, fields: Record<string, unknown>): Promise<OpenSignResult<true>> {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      body[key] = value === null ? { __op: 'Delete' } : value;
    }
    const result = await this.restCall<unknown>('PUT', `/classes/contracts_Document/${docId}`, body, true);
    if (!result.success) return { success: false, error: result.error };
    return { success: true, data: true };
  }

}

/**
 * Marks a message OpenSign must not send.
 *
 * In a document signed in order, the signer's browser asks OpenSign to mail the next signer as soon
 * as it has signed, using the document's own template. Where Scentic delivers every message itself,
 * that template is only this marker, and the patched mail function (deploy/opensign-server-patches.mjs)
 * answers success without sending anything that carries it.
 */
/**
 * The first X-Forwarded-For entry OpenSign will record as the signer's address. Where Scentic does
 * not know it, "unknown" (the token RFC 7239 gives for exactly this) — never left out, because
 * then OpenSign would record this gateway's own address as the signer's.
 */
export function forwardedFor(ipAddress: string): string {
  return ipAddress.trim() || 'unknown';
}

export const SCENTIC_DELIVERS_MARKER = 'data-scentic-delivers';

export const SCENTIC_DELIVERS_TEMPLATE = {
  subject: 'Scentic delivers this message',
  body: `<div ${SCENTIC_DELIVERS_MARKER}="1"></div>`,
} as const;

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

/**
 * The link a signer follows, in the form OpenSign's own sender builds it.
 *
 * base64 of "<documentId>/<email>/<contactId>", appended to the frontend's
 * /login route. The contact id is what ties the opened link back to a specific
 * signer on the document; without it the link identifies a document and an
 * address and OpenSign cannot tell which placeholder is being signed.
 */
/** What both the invitation and the reminder need in order to be sent. */
export interface SigningMailParams {
  docId: string;
  documentName: string;
  recipientEmail: string;
  recipientName: string;
  contactId: string;
  senderName: string;
  extUserId: string;
  publicUrl: string;
  /** The sender's own subject and note, where they wrote them. */
  subject?: string;
  message?: string;
  /** When the request lapses, shown so the signer knows how long they have. */
  expiresAt?: string;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The invitation or reminder a signer receives.
 *
 * Reads as a message from the firm: the firm's name at the top, the sender's own subject and note
 * where they wrote one, the document's title, one button. A reminder says it is one — a second
 * identical email reads as a system fault.
 *
 * `{{...}}` placeholders are OpenSign's own; with `link` left as `{{signing_url}}` and the name as
 * `{{receiver_name}}` the same template serves as the wording OpenSign uses when it invites the
 * next signer of a document signed in order.
 */
export function signingMail(params: {
  kind: 'invitation' | 'reminder';
  senderName: string;
  documentName: string;
  recipientName: string;
  link: string;
  subject?: string;
  message?: string;
  expiresAt?: string;
}): { subject: string; html: string } {
  const sender = escapeHtml(params.senderName);
  const title = escapeHtml(params.documentName);
  const custom = params.subject?.trim();
  const subject =
    params.kind === 'reminder'
      ? `Reminder: ${custom || params.documentName}`
      : custom || `Please sign: ${params.documentName}`;

  const greeting = params.recipientName.trim() ? `Hello ${escapeHtml(params.recipientName.trim())},` : 'Hello,';
  const lead =
    params.kind === 'invitation'
      ? `${sender} sent you <strong>${title}</strong> to sign.`
      : `<strong>${title}</strong> is still waiting for your signature.`;
  const note = params.message?.trim()
    ? `<p style="margin:0 0 16px;padding:12px 14px;background:#f4f5f7;border-radius:6px;white-space:pre-line">${escapeHtml(params.message.trim())}</p>`
    : '';
  const expiry = params.expiresAt
    ? `<p style="margin:16px 0 0;color:#5f6368;font-size:13px">Sign by ${escapeHtml(params.expiresAt)}.</p>`
    : '';
  const link = escapeHtml(params.link);

  const html =
    `<div style="font-family:Segoe UI,Arial,sans-serif;color:#1f2329;max-width:560px;margin:0 auto">` +
    `<p style="margin:0 0 20px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#5f6368">${sender}</p>` +
    `<p style="margin:0 0 12px">${greeting}</p>` +
    `<p style="margin:0 0 16px">${lead}</p>` +
    note +
    `<p style="margin:0"><a href="${link}" style="display:inline-block;padding:11px 22px;background:#1a3d7c;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Review and sign</a></p>` +
    expiry +
    `</div>`;

  return { subject, html };
}

export function signingUrlFor(publicUrl: string, docId: string, email: string, contactId: string): string {
  const token = Buffer.from(`${docId}/${email}/${contactId}`).toString('base64');
  return `${publicUrl.replace(/\/+$/, '')}/login/${token}`;
}
