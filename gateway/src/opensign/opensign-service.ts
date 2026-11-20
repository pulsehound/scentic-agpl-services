/**
 * OpenSign service — orchestrates client + mapping store + event outbox.
 *
 * All operations are Firm-scoped. Cross-Firm access is rejected.
 * Idempotent creates via scenticSignatureWorkflowId.
 * Event publishing for status changes and completion.
 * Polling model for status detection (no native webhooks).
 *
 * Security:
 * - Never logs signer emails, document contents, signing links, or session tokens
 * - Signer emails are hashed in events/logs
 * - Raw OpenSign errors are wrapped safely
 */

import { buildPlaceholders, dateFormatOrDefault } from './placeholders.js';
import { parseDate } from './types.js';
import { signingMail, signingUrlFor, SCENTIC_DELIVERS_TEMPLATE } from './opensign-client.js';
import { createHash as hashOf } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { DocumentAcl, OpenSignClient } from './opensign-client.js';
import { WorkflowLockBusy, type MappingStore } from '../mappings/mapping-store.js';
import type { EventOutbox } from '../events/outbox.js';
import type {
  OpenSignDocument,
  OpenSignDocumentStatus,
  OpenSignHealthStatus,
  OpenSignResult,
  OpenSignSignerStatus,
} from './types.js';
import { deriveDocumentStatus } from './types.js';
import { closedReason, declinedByEmail, isChangeError, signerRows, withSignatureRevoked, withSignerReplaced, type SignerState } from './signer-changes.js';
import {
  DEFAULT_MAX_PDF_BYTES,
  KeyedMutex,
  MAX_RELATED_DOCUMENTS,
  checkAuditEvents,
  checkDocumentPosition,
  checkRelatedDocuments,
  mergeRelatedDocuments,
  checkDeclineReason,
  checkEmail,
  checkFirmName,
  checkIpAddress,
  checkPdfBase64,
  checkSenderEmail,
  checkSha256,
  checkSignaturePng,
  checkSignerName,
  sha256Hex,
  withSignerName,
} from './ceremony.js';
import type {
  CreateOpenSignWorkflowParams,
  SyncOpenSignFirmParams,
  SyncOpenSignUserParams,
  OpenSignWorkflowMapping,
  SignatureCeremony,
} from '../mappings/types.js';
import {
  notFound,
  firmScopeViolation,
  invalidInput,
  conflict,
  notSupported,
  upstreamUnavailable,
  wrapUpstreamError,
  invalidState,
  notASigner,
  alreadySigned,
  staleDocument,
  payloadTooLarge,
  forbidden,
  busy,
  type GatewayError,
} from '../http/errors.js';

/** How long after an unanswered signPdf a workflow's signatures are held back: four minutes. */
export const SIGN_IN_DOUBT_MS = 4 * 60_000;
/**
 * The same, where the request provably did not reach OpenSign: no connection could be made
 * (refused, no such host, no route, no connection in time). The wait is short: a signer is not
 * kept four minutes for a write that never started. Every other failure without a refusal keeps
 * the long wait — a timeout, a 500, a 502, a 503, a 504, a connection that broke after the
 * request was written, a 200 that did not say it had signed. A 502 or 503 is among them (review
 * of round 76, L-3): the front end in front of OpenSign answers so also when an instance stopped
 * or a connection was reset after the request had been handed to it, so it does not prove that
 * nothing was written.
 */
export const SIGN_IN_DOUBT_SHORT_MS = 30_000;

export interface OpenSignServiceConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  completionTimeoutSeconds: number;
  /** Where a signer opens the document. The frontend, not the API. */
  publicUrl: string;
  /** The largest stamped PDF a ceremony submission may carry, decoded. From the body limit. */
  ceremonyMaxPdfBytes?: number;
}

/**
 * The audit trail's view of each signer, with a refusal put on the signer who made it.
 *
 * OpenSign writes a refusal on the document and nothing in the trail, so the trail alone can never
 * say a signer declined. Their entry (they will have opened the document) becomes 'declined'; with
 * no entry at all, one is added.
 */
export function signerStatusesWithDecline(doc: OpenSignDocument): { signers: OpenSignSignerStatus[]; declinedByEmail: string } {
  const signers = signerStatusesFrom(doc);
  const declinedBy = declinedByEmail(doc);
  if (declinedBy) {
    const own = signers.filter((s) => s.email === declinedBy && s.status !== 'Signed' && s.status !== 'Approved');
    if (own.length > 0) for (const entry of own) entry.status = 'declined';
    else if (!signers.some((s) => s.email === declinedBy)) signers.push({ email: declinedBy, status: 'declined' });
  }
  return { signers, declinedByEmail: declinedBy };
}

type ServiceResult<T> = { success: true; data: T } | { success: false; error: GatewayError };

/**
 * Who did what to a document, and from where.
 *
 * OpenSign keeps these in two places that do not reference each other by
 * anything a caller can use. The audit trail records the activity, the time and
 * the originating address, but names its subject by an internal object id. The
 * placeholders carry the email address. Joining them here is the only way a
 * status response can say "jane@example.com opened it on Tuesday" rather than
 * "somebody did something".
 *
 * That join is why the status endpoint used to be useless: it returned an
 * activity and a timestamp with no address, so Scentic matched none of it to a
 * recipient and reported that nothing had changed no matter what had.
 *
 * Entries the placeholders cannot explain are still returned, without an email.
 * Dropping them would silently hide activity by a signer added outside this
 * integration, which is exactly the thing somebody checking a status wants to
 * know about.
 */
export function signerStatusesFrom(doc: OpenSignDocument): OpenSignSignerStatus[] {
  const emailByObjectId = new Map<string, string>();
  for (const placeholder of doc.Placeholders || []) {
    const objectId = placeholder.signerObjId ?? placeholder.signerPtr?.objectId;
    const email = placeholder.email?.trim().toLowerCase();
    if (objectId && email) emailByObjectId.set(objectId, email);
  }

  return (doc.AuditTrail || []).map((entry) => ({
    email: entry.UserPtr?.objectId ? emailByObjectId.get(entry.UserPtr.objectId) : undefined,
    status: entry.Activity,
    signedAt: entry.SignedOn,
    viewedAt: entry.ViewedOn,
    ipAddress: entry.ipAddress,
  }));
}

export class OpenSignService {
  constructor(
    private client: OpenSignClient,
    private store: MappingStore,
    private outbox: EventOutbox,
    private config: OpenSignServiceConfig,
  ) {}

  // ── Health ────────────────────────────────────────────────────────────

  async checkHealth(): Promise<ServiceResult<OpenSignHealthStatus>> {
    if (!this.config.enabled) {
      return { success: true, data: { reachable: false } };
    }
    const result = await this.client.getStatus();
    if (!result.success) {
      return { success: true, data: { reachable: false } };
    }
    return { success: true, data: result.data! };
  }

  // ── Firm init ─────────────────────────────────────────────────────────

  async initFirm(params: SyncOpenSignFirmParams, correlationId: string): Promise<ServiceResult<{ opensignTenantId: string; opensignTenantName: string }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    // Check existing mapping (idempotent)
    const existing = await this.store.getOpenSignFirmMapping(params.scenticFirmId);
    if (existing && existing.status === 'ACTIVE') {
      return { success: true, data: { opensignTenantId: existing.opensignTenantId, opensignTenantName: existing.opensignTenantName } };
    }

    // Create tenant in OpenSign
    const tenantResult = await this.client.createTenant(params.firmName, `firm-${params.scenticFirmId}@scentic.local`);
    if (!tenantResult.success) {
      await this.outbox.publish({
        eventType: 'OPENSIGN_SYNC_FAILED',
        scenticFirmId: params.scenticFirmId,
        correlationId,
        payload: { operation: 'initFirm' },
        safeSummary: `OpenSign firm init failed for firm ${params.scenticFirmId}`,
      });
      return { success: false, error: wrapUpstreamError('OpenSign', 'createTenant', tenantResult.error) };
    }

    const tenant = tenantResult.data!;
    await this.store.upsertOpenSignFirmMapping(params, tenant.objectId, params.firmName);

    await this.outbox.publish({
      eventType: 'OPENSIGN_FIRM_INITIALIZED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { opensignTenantId: tenant.objectId },
      safeSummary: `OpenSign firm initialized for firm ${params.scenticFirmId}`,
    });

    return { success: true, data: { opensignTenantId: tenant.objectId, opensignTenantName: params.firmName } };
  }

  // ── User sync ─────────────────────────────────────────────────────────

  async syncUser(params: SyncOpenSignUserParams, correlationId: string): Promise<ServiceResult<{ opensignUserId: string }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const firmMapping = await this.store.getOpenSignFirmMapping(params.scenticFirmId);
    if (!firmMapping || firmMapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('OpenSign firm mapping not found. Initialize firm first.') };
    }

    // Check existing (idempotent)
    const existing = await this.store.getOpenSignUserMapping(params.scenticFirmId, params.scenticUserId);
    if (existing && existing.status === 'ACTIVE') {
      return { success: true, data: { opensignUserId: existing.opensignUserId } };
    }

    // Add user to OpenSign via adduser Cloud Function
    const password = `scentic-${params.scenticUserId}-${Date.now()}`;
    const userResult = await this.client.addUser({
      name: params.name,
      email: params.email,
      password,
      role: 'contracts_User',
      tenantId: firmMapping.opensignTenantId,
    });

    if (!userResult.success) {
      await this.outbox.publish({
        eventType: 'OPENSIGN_SYNC_FAILED',
        scenticFirmId: params.scenticFirmId,
        correlationId,
        payload: { operation: 'syncUser', scenticUserId: params.scenticUserId },
        safeSummary: `OpenSign user sync failed for user ${params.scenticUserId} in firm ${params.scenticFirmId}`,
      });
      return { success: false, error: wrapUpstreamError('OpenSign', 'addUser', userResult.error) };
    }

    // Login to get session token
    const loginResult = await this.client.login(params.email, password);
    const sessionToken = loginResult.success ? loginResult.data!.sessionToken : '';

    await this.store.upsertOpenSignUserMapping(params, userResult.data!.objectId, sessionToken);

    await this.outbox.publish({
      eventType: 'OPENSIGN_USER_SYNCED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { scenticUserId: params.scenticUserId, opensignUserId: userResult.data!.objectId },
      safeSummary: `OpenSign user synced for user ${params.scenticUserId} in firm ${params.scenticFirmId}`,
    });

    return { success: true, data: { opensignUserId: userResult.data!.objectId } };
  }

  // ── Create workflow ───────────────────────────────────────────────────

  async createWorkflow(params: CreateOpenSignWorkflowParams, correlationId: string): Promise<ServiceResult<OpenSignWorkflowMapping>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    // Validate required fields
    if (!params.scenticSignatureWorkflowId || !params.scenticDocumentId || !params.documentBase64) {
      return { success: false, error: invalidInput('scenticSignatureWorkflowId, scenticDocumentId, and documentBase64 are required') };
    }
    if (!params.signers || params.signers.length === 0) {
      return { success: false, error: invalidInput('At least one signer is required') };
    }
    // The sender's address, for the certificate. One address or nothing: never a list or a host.
    const originatorIp = checkIpAddress(params.originatorIp, 'originatorIp');
    if (!originatorIp.ok) return { success: false, error: invalidInput('Invalid request', [originatorIp]) };
    // The firm's name as it is today, if the caller says; otherwise the one it was set up with.
    const firmName = checkFirmName(params.firmName);
    if (!firmName.ok) return { success: false, error: invalidInput('Invalid request', [firmName]) };
    // The sender's own address, printed as the originator's. Never written to by anything here.
    const senderEmail = checkSenderEmail(params.senderEmail);
    if (!senderEmail.ok) return { success: false, error: invalidInput('Invalid request', [senderEmail]) };

    // Check existing (idempotent)
    const existing = await this.store.getOpenSignWorkflowMapping(params.scenticFirmId, params.scenticSignatureWorkflowId);
    if (existing && existing.status === 'ACTIVE') {
      return { success: true, data: existing };
    }

    // Verify firm mapping exists
    const firmMapping = await this.store.getOpenSignFirmMapping(params.scenticFirmId);
    if (!firmMapping || firmMapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('OpenSign firm mapping not found. Initialize firm first.') };
    }

    // The name signers read. The stored file's name is a fallback only.
    const title = params.documentTitle?.trim() || params.documentName;
    const expiresInDays = params.expiresInDays ?? 15;
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });

    // Signers in the order they act. With sendInOrder OpenSign invites each after the one before
    // has signed, walking the placeholders in this order.
    //
    // Viewers are left out. This edition of OpenSign counts every placeholder towards completion
    // ("viewers excluded" is its enterprise edition), so a viewer on the document would be invited
    // to sign and the document would never complete without their signature. A copy for a viewer
    // is sent by Scentic once the document is signed.
    const signers = [...params.signers]
      .filter((s) => s.role.toLowerCase() !== 'viewer')
      .sort((a, b) => a.order - b.order);
    if (signers.length === 0) {
      return { success: false, error: invalidInput('At least one recipient must sign or approve') };
    }

    // Upload document to OpenSign
    const uploadResult = await this.client.uploadFile(params.documentBase64, params.documentName);
    if (!uploadResult.success) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'uploadFile', uploadResult.error) };
    }

    // Get or create a user for the sender (use first synced user or admin)
    const userMapping = await this.store.getOpenSignUserMapping(params.scenticFirmId, params.signers[0].scenticSignerId);
    const extUserPtr = userMapping
      ? { objectId: userMapping.opensignUserId, __type: 'Pointer', className: '_User' }
      : { objectId: '', __type: 'Pointer', className: '_User' };

    // Create document in OpenSign
    // The wording OpenSign uses for the next signer of a document signed in order, in its own
    // variable syntax — the same template the gateway sends, so every signer reads the same mail.
    //
    // Where Scentic hosts the ceremony there is no OpenSign page to invite anybody to, so every
    // message is Scentic's whether or not the caller also said so.
    const scenticCeremony = params.ceremony === 'scentic';
    const scenticDelivers = params.scenticDelivers === true || scenticCeremony;
    const relay = scenticDelivers
      ? { subject: SCENTIC_DELIVERS_TEMPLATE.subject, html: SCENTIC_DELIVERS_TEMPLATE.body }
      : signingMail({
          kind: 'invitation',
          senderName: params.senderName || 'Your legal team',
          documentName: title,
          // OpenSign fills {{receiver_name}} from a contact name it does not have for the next signer.
          recipientName: '',
          link: '{{signing_url}}',
          subject: params.emailSubject,
          message: params.emailMessage,
          expiresAt,
        });

    const docResult = await this.client.createDocument({
      name: title,
      url: uploadResult.data!.url,
      extUserPtr,
      signers: [],
      // Emails are lowercased inside buildPlaceholders. linkContactToDoc
      // lowercases the address it is given and compares it against the
      // placeholder exactly; a signer entered as "Name@Firm.com" finds no
      // placeholder, and the mismatch surfaces as OPERATION_FORBIDDEN
      // "unauthorized" rather than as anything to do with an address.
      placeholders: buildPlaceholders(signers, params.fields ?? [], Math.random, dateFormatOrDefault(params.dateFormat)),
      timeToCompleteDays: expiresInDays,
      // Scentic's ceremony: OpenSign orders nothing (SendinOrder and SendInOrderStrict both off).
      // Scentic decides whose turn it is and lets the signers of one step sign at the same time;
      // OpenSign's strict order would refuse the second of two people signing in one step.
      sendinOrder: !scenticCeremony && params.sendInOrder === true && signers.length > 1,
      // Each signer enters a code emailed to them before the document opens: the id in a signing
      // link alone shows nothing to a forwarded invitation or to somebody since replaced.
      isEnableOTP: true,
      firmName: firmMapping.opensignTenantName || undefined,
      certificateFirmName: firmName.value || undefined,
      originatorIp: originatorIp.value || undefined,
      senderEmail: senderEmail.value || undefined,
      // Scentic tells the firm; OpenSign would mail its own admin account for every signature.
      notifyOnSignatures: false,
      redirectUrl: params.redirectUrl || undefined,
      requestSubject: relay.subject,
      requestBody: relay.html,
      senderName: params.senderName || undefined,
      // Scentic chases signers on its own schedule, in its own words.
      automaticReminders: !scenticDelivers,
      // Marked so OpenSign's own page cannot be a second way in to a document Scentic orders.
      scenticCeremony,
    });

    if (!docResult.success) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'createDocument', docResult.error) };
    }

    const opensignDocId = docResult.data!.objectId;

    // Link signers to document. In order, only the first is invited now; OpenSign invites each
    // of the rest when the one before has signed.
    const inOrder = params.sendInOrder === true && signers.length > 1;
    for (const [position, signer] of signers.entries()) {
      const linkResult = await this.client.linkContactToDoc({
        docId: opensignDocId,
        email: signer.email.trim().toLowerCase(),
        name: signer.name,
      });
      if (!linkResult.success) {
        // Continue with other signers; log the issue
        await this.outbox.publish({
          eventType: 'OPENSIGN_SYNC_FAILED',
          scenticFirmId: params.scenticFirmId,
          correlationId,
          payload: { operation: 'linkContactToDoc', signerId: signer.scenticSignerId },
          safeSummary: `OpenSign signer link failed for signer ${signer.scenticSignerId}`,
        });
      } else if (linkResult.data) {
        const emailHash = createHash('sha256').update(signer.email).digest('hex');
        await this.store.upsertOpenSignSignerMapping(
          params.scenticFirmId,
          params.scenticSignatureWorkflowId,
          signer.scenticSignerId,
          linkResult.data.objectId,
          emailHash,
        );

        // The document exists and the signer is attached to it. Until this
        // call, nothing told them so: sendNow was accepted at the route,
        // carried through the types, and acted on nowhere, so every send
        // succeeded and every signer waited for an email that was never
        // composed.
        //
        // A failure here is recorded, not raised. The document is filed and the
        // signer is linked — the work is done and re-sending is a normal
        // action, so an unreachable mail provider must not undo it.
        if (params.sendNow && !scenticDelivers && (!inOrder || position === 0)) {
          const invited = await this.client.sendSigningInvitation({
            docId: opensignDocId,
            documentName: title,
            subject: params.emailSubject,
            message: params.emailMessage,
            expiresAt,
            recipientEmail: signer.email.trim().toLowerCase(),
            recipientName: signer.name,
            contactId: linkResult.data.objectId,
            senderName: params.senderName || 'Your legal team',
            extUserId: extUserPtr.objectId,
            publicUrl: this.config.publicUrl,
          });
          if (!invited.success) {
            await this.outbox.publish({
              eventType: 'OPENSIGN_SYNC_FAILED',
              scenticFirmId: params.scenticFirmId,
              correlationId,
              payload: { operation: 'sendSigningInvitation', signerId: signer.scenticSignerId },
              safeSummary: `OpenSign invitation could not be sent for signer ${signer.scenticSignerId}`,
            });
          }
        }
      } else {
        // Reported success with nothing to record. Treated as the failure it is
        // rather than dereferenced — this exact line, with a non-null
        // assertion on it, is what turned a swallowed upstream error into an
        // unexplained 500 for the person sending the document.
        await this.outbox.publish({
          eventType: 'OPENSIGN_SYNC_FAILED',
          scenticFirmId: params.scenticFirmId,
          correlationId,
          payload: { operation: 'linkContactToDoc', signerId: signer.scenticSignerId },
          safeSummary: `OpenSign returned no contact for signer ${signer.scenticSignerId}`,
        });
      }
    }

    // Scentic shows this document itself, so no signer's account needs to be able to open it in
    // OpenSign: linking put each on the ACL, and they are taken off again. Not done, the request is
    // not made: a document its signers could reach around Scentic is not the one that was asked for.
    if (scenticCeremony) {
      const restricted = await this.client.restrictToPlatform(opensignDocId);
      if (!restricted.success) {
        await this.client.cancelDocument(opensignDocId, '', 'could not be closed to its signers');
        return { success: false, error: wrapUpstreamError('OpenSign', 'restrictToPlatform', restricted.error) };
      }
    }

    // Store workflow mapping
    const workflowMapping = await this.store.upsertOpenSignWorkflowMapping(
      params,
      opensignDocId,
      opensignDocId, // workflow ID = document ID in OpenSign
      'DRAFT',
    );

    await this.outbox.publish({
      eventType: 'OPENSIGN_WORKFLOW_CREATED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: {
        scenticSignatureWorkflowId: params.scenticSignatureWorkflowId,
        opensignDocumentId: opensignDocId,
        signerCount: params.signers.length,
      },
      safeSummary: `OpenSign workflow created for workflow ${params.scenticSignatureWorkflowId} in firm ${params.scenticFirmId}`,
    });

    return { success: true, data: workflowMapping };
  }

  // ── Get workflow status ───────────────────────────────────────────────

  async getWorkflowStatus(scenticFirmId: string, scenticSignatureWorkflowId: string, correlationId: string): Promise<ServiceResult<{ status: OpenSignDocumentStatus; opensignDocumentId: string; ceremony: SignatureCeremony; signers: OpenSignSignerStatus[]; declineReason: string | null; declinedByEmail: string; expiresAt: string | null; completedPdfReady: boolean; certificateReady: boolean }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }

    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', docResult.error) };
    }

    const doc = docResult.data!;
    const status = deriveDocumentStatus(doc);

    // Update stored status if changed
    if (mapping.opensignStatus !== status) {
      await this.store.updateOpenSignWorkflowStatus(scenticFirmId, scenticSignatureWorkflowId, status);
      await this.outbox.publish({
        eventType: 'OPENSIGN_WORKFLOW_STATUS_CHANGED',
        scenticFirmId,
        correlationId,
        payload: {
          scenticSignatureWorkflowId,
          opensignDocumentId: mapping.opensignDocumentId,
          oldStatus: mapping.opensignStatus,
          newStatus: status,
        },
        safeSummary: `Workflow ${scenticSignatureWorkflowId} status changed to ${status}`,
      });
    }

    // Extract signer statuses from the audit trail.
    //
    // The email comes from the placeholders, not the trail: an audit entry
    // identifies its signer by an internal object id, and without resolving it
    // the caller receives a list of things that happened with no way to say who
    // they happened to. Scentic could not match a single entry to a recipient,
    // so "check for updates" reported nothing had changed however much had.
    // A refusal is on the document, not in the trail: put on the signer who made it.
    const { signers, declinedByEmail: declinedBy } = signerStatusesWithDecline(doc);

    return {
      success: true,
      data: {
        status,
        opensignDocumentId: mapping.opensignDocumentId,
        ceremony: mapping.ceremony ?? 'hosted',
        signers,
        declineReason: doc.DeclineReason ?? null,
        declinedByEmail: declinedBy,
        expiresAt: parseDate(doc.ExpiryDate)?.toISOString() ?? null,
        completedPdfReady: !!doc.SignedUrl && doc.IsCompleted,
        certificateReady: !!doc.CertificateUrl,
      },
    };
  }

  // ── Send workflow ─────────────────────────────────────────────────────

  async sendWorkflow(scenticFirmId: string, scenticSignatureWorkflowId: string, correlationId: string): Promise<ServiceResult<{ status: string }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }

    // OpenSign sends emails automatically when signers are linked via linkcontacttodoc.
    // There is no separate "send" Cloud Function. The document is already sent when
    // signers are linked. We update the status to SENT if it was DRAFT.
    if (mapping.opensignStatus === 'DRAFT') {
      await this.store.updateOpenSignWorkflowStatus(scenticFirmId, scenticSignatureWorkflowId, 'SENT');
    }

    await this.outbox.publish({
      eventType: 'OPENSIGN_WORKFLOW_SENT',
      scenticFirmId,
      correlationId,
      payload: {
        scenticSignatureWorkflowId,
        opensignDocumentId: mapping.opensignDocumentId,
      },
      safeSummary: `Workflow ${scenticSignatureWorkflowId} sent for signature`,
    });

    return { success: true, data: { status: 'SENT' } };
  }

  // ── Cancel workflow ───────────────────────────────────────────────────

  async cancelWorkflow(scenticFirmId: string, scenticSignatureWorkflowId: string, reason: string, correlationId: string): Promise<ServiceResult<{ status: string }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }

    if (mapping.opensignStatus === 'COMPLETED') {
      return { success: false, error: conflict('Cannot cancel a completed workflow') };
    }

    // OpenSign does not have a "void" function. The closest is declinedoc.
    // This marks the document as declined, which is the best available cancellation.
    const cancelResult = await this.client.cancelDocument(mapping.opensignDocumentId, '', reason);
    if (!cancelResult.success) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'cancelDocument', cancelResult.error) };
    }

    await this.store.updateOpenSignWorkflowStatus(scenticFirmId, scenticSignatureWorkflowId, 'VOIDED');

    await this.outbox.publish({
      eventType: 'OPENSIGN_WORKFLOW_CANCELLED',
      scenticFirmId,
      correlationId,
      payload: {
        scenticSignatureWorkflowId,
        opensignDocumentId: mapping.opensignDocumentId,
        reason,
      },
      safeSummary: `Workflow ${scenticSignatureWorkflowId} cancelled: ${reason}`,
    });

    return { success: true, data: { status: 'VOIDED' } };
  }

  // ── Send reminder ─────────────────────────────────────────────────────

  async sendReminder(scenticFirmId: string, scenticSignatureWorkflowId: string, signerEmails: string[], senderName: string, correlationId: string): Promise<ServiceResult<{ remindedCount: number }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }

    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success || !docResult.data) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', docResult.error) };
    }
    const doc = docResult.data;

    // Whoever the caller named, narrowed to people who can still act on it.
    // Chasing somebody who has already signed tells them their signature did
    // not register, which is worse than not chasing at all.
    const wanted = new Set(signerEmails.map((email) => email.trim().toLowerCase()).filter(Boolean));
    const done = new Set(
      signerStatusesFrom(doc)
        .filter((signer) => signer.status === 'Signed' || signer.status === 'Declined')
        .map((signer) => signer.email)
        .filter((email): email is string => Boolean(email)),
    );

    const recipients = (doc.Placeholders || [])
      .map((placeholder) => ({
        email: (placeholder.email ?? '').trim().toLowerCase(),
        contactId: placeholder.signerObjId ?? placeholder.signerPtr?.objectId ?? '',
        role: (placeholder.Role ?? 'signer').toLowerCase(),
      }))
      // A viewer or a prefill placeholder has nothing to sign, so there is
      // nothing to remind them of.
      .filter((r) => r.email && r.contactId && r.role !== 'viewer' && r.role !== 'prefill')
      .filter((r) => !done.has(r.email))
      .filter((r) => wanted.size === 0 || wanted.has(r.email));

    if (recipients.length === 0) {
      return { success: true, data: { remindedCount: 0 } };
    }

    // The sender of the document itself, so a reminder comes from whoever sent
    // the invitation rather than from whichever user was looked up at the time.
    const extUserId = doc.ExtUserPtr?.objectId ?? '';

    // The firm's own name, from its tenant, unless the caller named one. Held
    // here rather than sent on every call because a counterparty must not see
    // two different names chasing them for the same document.
    const firmMapping = await this.store.getOpenSignFirmMapping(scenticFirmId);
    const from = senderName || firmMapping?.opensignTenantName || 'Your legal team';

    let remindedCount = 0;
    for (const recipient of recipients) {
      const sent = await this.client.sendSigningReminder({
        docId: mapping.opensignDocumentId,
        documentName: doc.Name,
        recipientEmail: recipient.email,
        // OpenSign holds no display name on the placeholder, and the audit
        // trail only names people who have already acted. The address is what
        // is certainly known, and a greeting to an address reads better than a
        // greeting to nobody.
        recipientName: recipient.email,
        contactId: recipient.contactId,
        senderName: from,
        extUserId,
        publicUrl: this.config.publicUrl,
      });

      if (sent.success) {
        remindedCount += 1;
      } else {
        // Recorded and carried on. One bad address must not stop the other
        // three from being chased, and the count returned says how many
        // actually went.
        await this.outbox.publish({
          eventType: 'OPENSIGN_SYNC_FAILED',
          scenticFirmId,
          correlationId,
          payload: { operation: 'sendSigningReminder', scenticSignatureWorkflowId },
          safeSummary: `OpenSign reminder could not be sent for workflow ${scenticSignatureWorkflowId}`,
        });
      }
    }

    await this.outbox.publish({
      eventType: 'OPENSIGN_WORKFLOW_REMINDER_SENT',
      scenticFirmId,
      correlationId,
      payload: {
        scenticSignatureWorkflowId,
        opensignDocumentId: mapping.opensignDocumentId,
        remindedCount,
      },
      safeSummary: `Reminded ${remindedCount} signer(s) on workflow ${scenticSignatureWorkflowId}`,
    });

    return { success: true, data: { remindedCount } };
  }

  // ── Poll workflow ─────────────────────────────────────────────────────

  async pollWorkflow(scenticFirmId: string, scenticSignatureWorkflowId: string, correlationId: string): Promise<ServiceResult<{ status: OpenSignDocumentStatus; changed: boolean; completedPdfReady: boolean; certificateReady: boolean; declineReason: string | null; declinedByEmail: string }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }

    // Skip polling if already in terminal state
    const terminalStates = ['COMPLETED', 'DECLINED', 'EXPIRED', 'VOIDED', 'FAILED'];
    if (terminalStates.includes(mapping.opensignStatus)) {
      // Nothing more can change, so OpenSign is not asked — except who declined and why, which is
      // on the document and nowhere here. Unreachable, that reads as unknown, not as a failure.
      let declineReason: string | null = null;
      let declinedBy = '';
      if (mapping.opensignStatus === 'DECLINED') {
        const declinedDoc = await this.client.getDocument(mapping.opensignDocumentId);
        if (declinedDoc.success && declinedDoc.data?.objectId) {
          declineReason = declinedDoc.data.DeclineReason ?? null;
          declinedBy = declinedByEmail(declinedDoc.data);
        }
      }
      return { success: true, data: { status: mapping.opensignStatus as OpenSignDocumentStatus, changed: false, completedPdfReady: mapping.opensignStatus === 'COMPLETED', certificateReady: mapping.opensignStatus === 'COMPLETED', declineReason, declinedByEmail: declinedBy } };
    }

    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success) {
      // OpenSign down — safe retry/failure state
      await this.outbox.publish({
        eventType: 'OPENSIGN_CONNECTION_HEALTH_CHANGED',
        scenticFirmId,
        correlationId,
        payload: { reachable: false },
        safeSummary: `OpenSign unreachable during poll for workflow ${scenticSignatureWorkflowId}`,
      });
      return { success: false, error: upstreamUnavailable('OpenSign is not reachable during polling') };
    }

    const doc = docResult.data!;
    const newStatus = deriveDocumentStatus(doc);
    const changed = mapping.opensignStatus !== newStatus;

    if (changed) {
      await this.store.updateOpenSignWorkflowStatus(scenticFirmId, scenticSignatureWorkflowId, newStatus);

      // Publish status change event
      await this.outbox.publish({
        eventType: 'OPENSIGN_WORKFLOW_STATUS_CHANGED',
        scenticFirmId,
        correlationId,
        payload: {
          scenticSignatureWorkflowId,
          opensignDocumentId: mapping.opensignDocumentId,
          oldStatus: mapping.opensignStatus,
          newStatus,
        },
        safeSummary: `Workflow ${scenticSignatureWorkflowId} status changed from ${mapping.opensignStatus} to ${newStatus}`,
      });

      // Publish completion events if completed
      if (newStatus === 'COMPLETED') {
        await this.outbox.publish({
          eventType: 'OPENSIGN_WORKFLOW_COMPLETED',
          scenticFirmId,
          correlationId,
          payload: {
            scenticSignatureWorkflowId,
            opensignDocumentId: mapping.opensignDocumentId,
            completedAt: new Date().toISOString(),
          },
          safeSummary: `Workflow ${scenticSignatureWorkflowId} completed`,
        });

        if (doc.SignedUrl) {
          await this.outbox.publish({
            eventType: 'OPENSIGN_COMPLETED_PDF_READY',
            scenticFirmId,
            correlationId,
            payload: {
              scenticSignatureWorkflowId,
              opensignDocumentId: mapping.opensignDocumentId,
              sha256: doc.DocumentHash,
            },
            safeSummary: `Completed PDF ready for workflow ${scenticSignatureWorkflowId}`,
          });
        }

        if (doc.CertificateUrl) {
          await this.outbox.publish({
            eventType: 'OPENSIGN_CERTIFICATE_READY',
            scenticFirmId,
            correlationId,
            payload: {
              scenticSignatureWorkflowId,
              opensignDocumentId: mapping.opensignDocumentId,
            },
            safeSummary: `Certificate ready for workflow ${scenticSignatureWorkflowId}`,
          });
        }
      }
    }

    return {
      success: true,
      data: {
        status: newStatus,
        changed,
        completedPdfReady: newStatus === 'COMPLETED' && !!doc.SignedUrl,
        certificateReady: newStatus === 'COMPLETED' && !!doc.CertificateUrl,
        declineReason: newStatus === 'DECLINED' ? doc.DeclineReason ?? null : null,
        declinedByEmail: declinedByEmail(doc),
      },
    };
  }

  // ── Poll all due workflows ────────────────────────────────────────────

  async pollDueWorkflows(scenticFirmId: string, correlationId: string): Promise<ServiceResult<{ polled: number; changed: number; completed: number }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const workflows = await this.store.listOpenSignWorkflowMappings(scenticFirmId);
    const terminalStates = new Set(['COMPLETED', 'DECLINED', 'EXPIRED', 'VOIDED', 'FAILED']);
    const activeWorkflows = workflows.filter(w => !terminalStates.has(w.opensignStatus));

    let polled = 0;
    let changed = 0;
    let completed = 0;

    for (const workflow of activeWorkflows) {
      const result = await this.pollWorkflow(scenticFirmId, workflow.scenticSignatureWorkflowId, correlationId);
      polled++;
      if (result.success) {
        if (result.data.changed) changed++;
        if (result.data.status === 'COMPLETED') completed++;
      }
    }

    return { success: true, data: { polled, changed, completed } };
  }

  // ── Get completed PDF status ──────────────────────────────────────────

  async getCompletedStatus(scenticFirmId: string, scenticSignatureWorkflowId: string, _correlationId: string): Promise<ServiceResult<{ ready: boolean; sha256?: string; certificateReady: boolean }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }

    if (mapping.opensignStatus !== 'COMPLETED') {
      return { success: true, data: { ready: false, certificateReady: false } };
    }

    // Fetch document to get signed PDF and certificate status
    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', docResult.error) };
    }

    const doc = docResult.data!;
    return {
      success: true,
      data: {
        ready: !!doc.SignedUrl,
        sha256: doc.DocumentHash,
        certificateReady: !!doc.CertificateUrl,
      },
    };
  }

  // ── Completed file ────────────────────────────────────────────────────

  /**
   * The executed PDF or the certificate of completion, as bytes.
   *
   * Asks OpenSign for the document rather than trusting the stored status: a document signed a
   * minute ago has not been polled yet, and refusing to hand it over until a poll ran would make
   * filing depend on timing.
   */
  async getCompletedFile(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    kind: 'signed' | 'certificate',
  ): Promise<ServiceResult<{ bytes: Buffer; sha256: string }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }
    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }
    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success || !docResult.data) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', docResult.error) };
    }
    const doc = docResult.data;
    if (!doc.IsCompleted) {
      return { success: false, error: conflict('The document has not been signed by everybody yet.') };
    }
    const stored = kind === 'signed' ? doc.SignedUrl : doc.CertificateUrl;
    if (!stored) {
      return { success: false, error: notFound(kind === 'signed' ? 'No signed document yet.' : 'No certificate yet.') };
    }
    const file = await this.client.fetchDocumentFile(mapping.opensignDocumentId, stored);
    if (!file.success || !file.data) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'fetchDocumentFile', file.error) };
    }
    if (file.data.subarray(0, 5).toString('ascii') !== '%PDF-') {
      return { success: false, error: wrapUpstreamError('OpenSign', 'fetchDocumentFile', { code: 'OPENSIGN_API_ERROR', message: 'Not a PDF' }) };
    }
    return { success: true, data: { bytes: file.data, sha256: hashOf('sha256').update(file.data).digest('hex') } };
  }


  // ── The signing ceremony Scentic hosts ────────────────────────────────
  //
  // Scentic authenticates the signer (an emailed link and an emailed code), shows the document,
  // and stamps what the signer fills in onto the PDF on its own server. These four operations are
  // what it needs from here: the PDF as it stands, a record that the signer opened it, the
  // submission of the stamped PDF as that signer, and a refusal. OpenSign still holds the
  // document, counts the signatures, seals the last one and makes the certificate.

  /** One submission at a time per workflow, in this process. See KeyedMutex for what that covers. */
  private ceremonyLocks = new KeyedMutex();

  /**
   * One at a time per workflow, on every instance. The in-process lock first, so calls landing on
   * one instance queue here without each taking a database connection; then the store's lock,
   * which with PostgreSQL excludes the other instances too (MappingStore.withWorkflowLock). Held
   * across the whole of read, compare, write and submit. If the store's lock is not free in time
   * nothing has been done, and the caller is told to try again.
   */
  private async ceremonyLocked<T>(scenticFirmId: string, scenticSignatureWorkflowId: string, task: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    const key = `${scenticFirmId}:${scenticSignatureWorkflowId}`;
    return this.ceremonyLocks.run(key, async () => {
      try {
        return await this.store.withWorkflowLock(key, task);
      } catch (err) {
        if (err instanceof WorkflowLockBusy) {
          return { success: false as const, error: busy('Another signature on this request is being recorded. Try again in a moment.') };
        }
        throw err;
      }
    });
  }

  /** Why nothing more may be done to this document, or null while it is still out. */
  private ceremonyClosed(doc: OpenSignDocument): GatewayError | null {
    const closed = closedReason(doc);
    if (closed) return invalidState(closed.message);
    if (deriveDocumentStatus(doc) === 'EXPIRED') return invalidState('This request has expired.');
    return null;
  }

  /** The workflow's document, read fresh, or why the ceremony cannot touch it. */
  private async ceremonyDocument(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    purpose: 'read' | 'act',
  ): Promise<ServiceResult<OpenSignDocument>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }
    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }
    // These routes are Scentic's own signing page talking; a request whose signers sign on
    // OpenSign's page is not theirs to read or act on, whoever asks.
    if (mapping.ceremony !== 'scentic') {
      return { success: false, error: invalidState('This is not a Scentic-hosted request.') };
    }
    if (mapping.opensignStatus === 'VOIDED') {
      return { success: false, error: invalidState('This request was withdrawn.') };
    }
    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success || !docResult.data) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', docResult.error) };
    }
    const doc = docResult.data;
    // OpenSign's getDocument leaves archived documents out of its query and answers 200 with
    // `{ error }` instead of a document: a withdrawn request arrives here as an object with no id.
    if (!doc.objectId || doc.IsArchive) {
      return { success: false, error: invalidState('This request was withdrawn.') };
    }
    if (purpose === 'act') {
      const closed = this.ceremonyClosed(doc);
      if (closed) return { success: false, error: closed };
    }
    return { success: true, data: doc };
  }

  /** The document's PDF as it stands now: with every signature made so far, or the original. */
  private async currentPdf(doc: OpenSignDocument): Promise<ServiceResult<{ bytes: Buffer; sha256: string }>> {
    const stored = doc.SignedUrl || doc.URL;
    if (!stored) return { success: false, error: notFound('The document has no file.') };
    const file = await this.client.fetchDocumentFile(doc.objectId, stored);
    if (!file.success || !file.data) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'fetchDocumentFile', file.error) };
    }
    if (file.data.subarray(0, 4).toString('latin1') !== '%PDF') {
      return { success: false, error: wrapUpstreamError('OpenSign', 'fetchDocumentFile', { code: 'OPENSIGN_API_ERROR', message: 'Not a PDF' }) };
    }
    return { success: true, data: { bytes: file.data, sha256: sha256Hex(file.data) } };
  }

  /**
   * The current PDF, for Scentic to show and to stamp. Its hash is what a later submission names as
   * the PDF it was built on. Refused once the request is withdrawn; a declined or completed
   * document can still be read — the people on it may need to see what was refused or signed.
   */
  async getCeremonyFile(scenticFirmId: string, scenticSignatureWorkflowId: string): Promise<ServiceResult<{ bytes: Buffer; sha256: string }>> {
    const doc = await this.ceremonyDocument(scenticFirmId, scenticSignatureWorkflowId, 'read');
    if (!doc.success) return doc;
    return this.currentPdf(doc.data);
  }

  /** The signer on this document with that address, and the account that signs as them. */
  private async ceremonySigner(doc: OpenSignDocument, email: string): Promise<ServiceResult<{ contactId: string; userId: string; state: SignerState }>> {
    const row = signerRows(doc).find((r) => r.email === email);
    if (!row || !row.contactId) {
      return { success: false, error: notASigner('That address is not asked to sign this document.') };
    }
    // getDocument includes each contact, and with it the account; asked for only when it did not.
    let userId = (doc.Signers ?? []).find((s) => s?.objectId === row.contactId)?.UserId?.objectId ?? '';
    if (!userId) {
      const looked = await this.client.getContactUserId(row.contactId);
      if (!looked.success || !looked.data) {
        return { success: false, error: wrapUpstreamError('OpenSign', 'getContactUserId', looked.error) };
      }
      userId = looked.data;
    }
    return { success: true, data: { contactId: row.contactId, userId, state: row.state } };
  }

  /**
   * OpenSign's "Viewed" entry for one signer, with the signer's own address.
   *
   * Recorded once. OpenSign's triggerevent rewrites the signer's whole entry each time it is
   * called — a second call would move the time, and one made after signing would turn "Signed"
   * back into "Viewed" — so a signer already past this point is answered without calling it.
   */
  async ceremonyViewed(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    input: { email?: unknown; ipAddress?: unknown },
  ): Promise<ServiceResult<{ viewed: true; recorded: boolean }>> {
    const email = checkEmail(input.email);
    if (!email.ok) return { success: false, error: invalidInput('Invalid request', [email]) };
    const ip = checkIpAddress(input.ipAddress);
    if (!ip.ok) return { success: false, error: invalidInput('Invalid request', [ip]) };

    return this.ceremonyLocked<{ viewed: true; recorded: boolean }>(scenticFirmId, scenticSignatureWorkflowId, async () => {
      const doc = await this.ceremonyDocument(scenticFirmId, scenticSignatureWorkflowId, 'act');
      if (!doc.success) return doc;
      const signer = await this.ceremonySigner(doc.data, email.value);
      if (!signer.success) return signer;
      if (signer.data.state !== 'pending') {
        return { success: true, data: { viewed: true as const, recorded: false } };
      }
      const recorded = await this.client.recordViewed({
        docId: doc.data.objectId,
        contactId: signer.data.contactId,
        ipAddress: ip.value,
      });
      if (!recorded.success) {
        return { success: false, error: wrapUpstreamError('OpenSign', 'recordViewed', recorded.error) };
      }
      return { success: true, data: { viewed: true as const, recorded: true } };
    });
  }

  /**
   * Submit a signer's stamped PDF to OpenSign for that signer.
   *
   * Compare and swap: the caller names the hash of the PDF it stamped (`baseSha256`); if the
   * document's current PDF is not that one — another signer got there first — nothing is written
   * and the caller fetches the current PDF, stamps it again and retries. The check and the
   * submission run under a per-workflow lock in this process. Across gateway instances the lock
   * does not reach; there Scentic's own database claim on the request keeps two submissions for
   * one workflow from running at once.
   */
  async ceremonySign(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    input: { email?: unknown; signerName?: unknown; pdfBase64?: unknown; signaturePngBase64?: unknown; ipAddress?: unknown; baseSha256?: unknown; auditEvents?: unknown; relatedDocuments?: unknown; position?: unknown },
  ): Promise<ServiceResult<{ signed: true; completed: boolean; sha256: string }>> {
    const email = checkEmail(input.email);
    if (!email.ok) return { success: false, error: invalidInput('Invalid request', [email]) };
    const ip = checkIpAddress(input.ipAddress);
    if (!ip.ok) return { success: false, error: invalidInput('Invalid request', [ip]) };
    const base = checkSha256(input.baseSha256);
    if (!base.ok) return { success: false, error: invalidInput('Invalid request', [base]) };
    const pdf = checkPdfBase64(input.pdfBase64, this.config.ceremonyMaxPdfBytes ?? DEFAULT_MAX_PDF_BYTES);
    if (!pdf.ok) {
      return { success: false, error: pdf.issue === 'too large' ? payloadTooLarge('The document is too large.') : invalidInput('Invalid request', [pdf]) };
    }
    const png = checkSignaturePng(input.signaturePngBase64);
    if (!png.ok) {
      return { success: false, error: png.issue === 'too large' ? payloadTooLarge('The signature image is too large.') : invalidInput('Invalid request', [png]) };
    }
    const events = checkAuditEvents(input.auditEvents);
    if (!events.ok) return { success: false, error: invalidInput('Invalid request', [events]) };
    // The documents sent together in this request, and which of them this one is.
    const position = checkDocumentPosition(input.position);
    if (!position.ok) return { success: false, error: invalidInput('Invalid request', [position]) };
    const related = checkRelatedDocuments(input.relatedDocuments, position.value);
    if (!related.ok) return { success: false, error: invalidInput('Invalid request', [related]) };
    // The signer confirms their own name, and it is required: the only other name there is
    // belongs to a contact OpenSign shares across every firm.
    const name = checkSignerName(input.signerName, true);
    if (!name.ok) return { success: false, error: invalidInput('Invalid request', [name]) };

    return this.ceremonyLocked(scenticFirmId, scenticSignatureWorkflowId, async () => {
      const doc = await this.ceremonyDocument(scenticFirmId, scenticSignatureWorkflowId, 'read');
      if (!doc.success) return doc;
      // Whether this signer has signed is asked before whether the document is still open. The last
      // signature completes the document: a signer whose answer was lost on the way back, and who
      // asks again, must hear "you have signed" — not "the document is closed", which reads as
      // though their signature had been refused.
      if (signerRows(doc.data).find((row) => row.email === email.value)?.state === 'signed') {
        return { success: false, error: alreadySigned('That signer has already signed this document.') };
      }
      const closed = this.ceremonyClosed(doc.data);
      if (closed) return { success: false, error: closed };
      const signer = await this.ceremonySigner(doc.data, email.value);
      if (!signer.success) return signer;

      const current = await this.currentPdf(doc.data);
      if (!current.success) return current;

      // A signature handed to OpenSign a moment ago, by any instance, whose answer never came:
      // OpenSign may still be writing it, and the lock that covered it is gone. Whoever it was for
      // has been answered above if it has landed (already signed). Otherwise nothing is submitted
      // on top of it while the PDF is still the one it was sent against and the time allowed for
      // it has not run out: the caller is told to come back. Once the PDF has changed it has
      // landed, and once the time is up it will not; either way the mark is cleared.
      const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
      if (mapping?.signInDoubtUntil) {
        const stillInDoubt = new Date(mapping.signInDoubtUntil).getTime() > Date.now() && mapping.signInDoubtSha === current.data.sha256;
        if (stillInDoubt) {
          return { success: false, error: busy('An earlier signature on this request may still be being recorded. Try again in a moment.') };
        }
        await this.store.setOpenSignWorkflowSignInDoubt(scenticFirmId, scenticSignatureWorkflowId, null);
      }
      if (current.data.sha256 !== base.value) {
        return { success: false, error: staleDocument('The document has changed since it was opened. Fetch it again, apply the signature again, and retry.') };
      }

      // Scentic's own record of the ceremony, for the certificate. Written before the signature:
      // the last signature makes the certificate straight away, from what the document holds then.
      //
      // With it, the name this signer confirmed — on the document, beside the other signers' names,
      // and never on the contact or the account, which belong to every firm that writes to this
      // address. The certificate and the signature print it (deploy/opensign-server-patches.mjs).
      //
      // The documents of the request are merged into what the document already lists, by position,
      // and written only when that changes anything: each signer's submission carries the list,
      // and a later one that is shorter must not take a document off the certificate.
      const mergedRelated = related.value ? mergeRelatedDocuments(doc.data.ScenticRelatedDocuments, related.value, position.value) : undefined;
      if (mergedRelated === null) {
        return { success: false, error: invalidInput('Invalid request', [{ field: 'relatedDocuments', issue: `at most ${MAX_RELATED_DOCUMENTS} documents with those already listed` }]) };
      }
      const relatedChanged = mergedRelated !== undefined && JSON.stringify(mergedRelated) !== JSON.stringify(doc.data.ScenticRelatedDocuments ?? null);
      const fields: Record<string, unknown> = {
        ...(events.value ? { ScenticAudit: events.value } : {}),
        ...(name.value ? { ScenticSignerNames: withSignerName(doc.data.ScenticSignerNames, email.value, name.value) } : {}),
        ...(relatedChanged ? { ScenticRelatedDocuments: mergedRelated } : {}),
      };
      if (Object.keys(fields).length > 0) {
        const saved = await this.client.updateDocument(doc.data.objectId, fields);
        if (!saved.success) return { success: false, error: wrapUpstreamError('OpenSign', 'updateDocument', saved.error) };
      }

      const submitted = await this.client.signAsSigner({
        docId: doc.data.objectId,
        contactId: signer.data.contactId,
        pdfBase64: pdf.value.toString('base64'),
        signaturePngBase64: png.value,
        ipAddress: ip.value,
      });
      if (!submitted.success) {
        // Parse's OPERATION_FORBIDDEN: OpenSign itself refused this account for this document.
        if (submitted.error?.upstreamCode === 119) {
          return { success: false, error: forbidden('The signing service refused this signer for this document.') };
        }
        // OBJECT_NOT_FOUND: declined or withdrawn between the read above and the write.
        if (submitted.error?.upstreamCode === 101) {
          return { success: false, error: invalidState('This document can no longer be signed.') };
        }
        // Anything else that is not OpenSign saying no — no answer in time, a connection that
        // dropped, a 502, 503 or 504 from whatever stands in front of it, a 500 from OpenSign
        // itself — leaves it unknown whether the signature was taken. The lock is about to be let
        // go while OpenSign may still be writing: say so where every instance will see it. Only a
        // refusal is certain: a 4xx answer.
        //
        // For how long depends on what is known. Thirty seconds where the request provably did
        // not get in: the connection was never made. Four minutes, as long as OpenSign could
        // plausibly take, for everything else — a timeout, a 502 or 503 (a front end says so also
        // after handing the request on), a 504, a 500, a connection that broke once the request
        // was on it, a 200 that did not say it had signed. Either way the wait ends as
        // soon as the document shows what happened — the signer signed (answered above, before
        // this is looked at) or the PDF changed (the mark is cleared).
        const status = submitted.error?.httpStatus;
        const refused = typeof status === 'number' && status >= 400 && status < 500;
        const keptOut = submitted.error?.notReached === true;
        const doubtMs = keptOut ? SIGN_IN_DOUBT_SHORT_MS : SIGN_IN_DOUBT_MS;
        if (!refused) {
          await this.store.setOpenSignWorkflowSignInDoubt(scenticFirmId, scenticSignatureWorkflowId, {
            until: new Date(Date.now() + doubtMs).toISOString(),
            sha256: current.data.sha256,
          });
        }
        return { success: false, error: wrapUpstreamError('OpenSign', 'signPdf', submitted.error) };
      }

      // Read back rather than assumed: whether that was the last signature is OpenSign's to say.
      const after = await this.client.getDocument(doc.data.objectId);
      if (!after.success || !after.data?.objectId) {
        return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', after.error) };
      }
      if (signerRows(after.data).find((r) => r.email === email.value)?.state !== 'signed') {
        return { success: false, error: wrapUpstreamError('OpenSign', 'signPdf', { code: 'OPENSIGN_API_ERROR', message: 'Signature not recorded' }) };
      }
      const completed = after.data.IsCompleted === true;
      // Not completed: OpenSign stores the submitted bytes untouched, so their hash is the next
      // base. Completed: OpenSign sealed the PDF with its own certificate, and says what it hashed.
      const sealed = /^[0-9a-f]{64}$/i.test(after.data.DocumentHash ?? '') ? after.data.DocumentHash!.toLowerCase() : '';
      return { success: true, data: { signed: true as const, completed, sha256: completed ? sealed : sha256Hex(pdf.value) } };
    });
  }

  /**
   * A signer refuses the document, in their own words. OpenSign's declinedoc as that signer: the
   * document is declined for everybody, with the reason and who gave it.
   */
  async ceremonyDecline(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    input: { email?: unknown; reason?: unknown; ipAddress?: unknown },
  ): Promise<ServiceResult<{ declined: true }>> {
    const email = checkEmail(input.email);
    if (!email.ok) return { success: false, error: invalidInput('Invalid request', [email]) };
    const reason = checkDeclineReason(input.reason);
    if (!reason.ok) return { success: false, error: invalidInput('Invalid request', [reason]) };
    const ip = checkIpAddress(input.ipAddress);
    if (!ip.ok) return { success: false, error: invalidInput('Invalid request', [ip]) };

    return this.ceremonyLocked(scenticFirmId, scenticSignatureWorkflowId, async () => {
      const doc = await this.ceremonyDocument(scenticFirmId, scenticSignatureWorkflowId, 'read');
      if (!doc.success) return doc;
      // Asked twice by the same signer: it is declined, by them, already.
      if (doc.data.IsDeclined && declinedByEmail(doc.data) === email.value) {
        return { success: true, data: { declined: true as const } };
      }
      // What this signer has done comes before what state the document is in (see ceremonySign).
      if (signerRows(doc.data).find((row) => row.email === email.value)?.state === 'signed') {
        return { success: false, error: alreadySigned('That signer has already signed this document.') };
      }
      const closed = this.ceremonyClosed(doc.data);
      if (closed) return { success: false, error: closed };
      const signer = await this.ceremonySigner(doc.data, email.value);
      if (!signer.success) return signer;
      const declined = await this.client.declineAsSigner({
        docId: doc.data.objectId,
        userId: signer.data.userId,
        reason: reason.value,
        ipAddress: ip.value,
      });
      if (!declined.success) {
        if (declined.error?.upstreamCode === 119) {
          return { success: false, error: forbidden('The signing service refused this signer for this document.') };
        }
        if (declined.error?.upstreamCode === 101) {
          return { success: false, error: invalidState('This document can no longer be declined.') };
        }
        return { success: false, error: wrapUpstreamError('OpenSign', 'declinedoc', declined.error) };
      }
      return { success: true, data: { declined: true as const } };
    });
  }

  // ── Signers, their links, and changing them ───────────────────────────

  /** The document a workflow maps to, read fresh. */
  private async documentFor(scenticFirmId: string, scenticSignatureWorkflowId: string): Promise<ServiceResult<OpenSignDocument>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }
    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }
    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success || !docResult.data) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', docResult.error) };
    }
    return { success: true, data: docResult.data };
  }

  /**
   * Everyone asked to sign, in order, with where they have got to and — while it can still be
   * used — their personal link. For Scentic to send the messages itself; a link is never logged.
   */
  async listSigners(scenticFirmId: string, scenticSignatureWorkflowId: string): Promise<ServiceResult<{
    signers: Array<{ email: string; role: string; order: number; state: SignerState; signingUrl?: string }>;
  }>> {
    const doc = await this.documentFor(scenticFirmId, scenticSignatureWorkflowId);
    if (!doc.success) return doc;
    const open = closedReason(doc.data) === null;
    return {
      success: true,
      data: {
        signers: signerRows(doc.data).map((row) => ({
          email: row.email,
          role: row.role,
          order: row.order,
          state: row.state,
          // A link to OpenSign's page, which refuses a document Scentic hosts the signing of.
          ...(open && doc.data.ScenticCeremony !== true && row.contactId && row.state !== 'signed' && row.state !== 'declined'
            ? { signingUrl: signingUrlFor(this.config.publicUrl, doc.data.objectId, row.email, row.contactId) }
            : {}),
        })),
      },
    };
  }

  /**
   * Somebody else signs in place of one signer who has not signed yet. The old link stops working;
   * the new signer's link is returned for the caller to send.
   */
  async replaceSigner(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    change: { fromEmail: string; toEmail: string; toName: string },
    correlationId: string,
  ): Promise<ServiceResult<{ email: string; signingUrl: string }>> {
    if (!change.fromEmail || !change.toEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(change.toEmail.trim())) {
      return { success: false, error: invalidInput('fromEmail and a valid toEmail are required') };
    }
    const doc = await this.documentFor(scenticFirmId, scenticSignatureWorkflowId);
    if (!doc.success) return doc;
    const closed = closedReason(doc.data);
    if (closed) return { success: false, error: conflict(closed.message) };

    const next = withSignerReplaced(doc.data, change.fromEmail, change.toEmail);
    if (isChangeError(next)) return { success: false, error: next.code === 'NOT_A_SIGNER' ? notFound(next.message) : conflict(next.message) };

    // The person replaced loses their access to the document in the same write that takes their
    // place away: with codes on, a code to their own address would otherwise still open it.
    let access: { before: DocumentAcl; after: DocumentAcl } | null = null;
    if (next.oldContactId) {
      const read = await this.client.documentAccessWithout(doc.data.objectId, next.oldContactId);
      if (!read.success) return { success: false, error: wrapUpstreamError('OpenSign', 'documentAccessWithout', read.error) };
      access = read.data!;
    }

    const saved = await this.client.updateDocument(doc.data.objectId, {
      Placeholders: next.placeholders,
      Signers: next.signers,
      ...(access ? { ACL: access.after } : {}),
    });
    if (!saved.success) return { success: false, error: wrapUpstreamError('OpenSign', 'updateDocument', saved.error) };

    const email = change.toEmail.trim().toLowerCase();
    const linked = await this.client.linkContactToDoc({ docId: doc.data.objectId, email, name: change.toName.trim() || email });
    if (!linked.success || !linked.data) {
      // Put the original signer back rather than leave a placeholder nobody can sign.
      await this.client.updateDocument(doc.data.objectId, {
        Placeholders: doc.data.Placeholders,
        Signers: doc.data.Signers,
        ...(access ? { ACL: access.before } : {}),
      });
      return { success: false, error: wrapUpstreamError('OpenSign', 'linkContactToDoc', linked.error) };
    }

    // Linking put the new signer's account on the ACL; where Scentic hosts the signing it comes off.
    if (doc.data.ScenticCeremony === true) {
      const restricted = await this.client.restrictToPlatform(doc.data.objectId);
      if (!restricted.success) return { success: false, error: wrapUpstreamError('OpenSign', 'restrictToPlatform', restricted.error) };
    }

    await this.outbox.publish({
      eventType: 'OPENSIGN_SIGNER_REPLACED',
      scenticFirmId,
      correlationId,
      payload: { scenticSignatureWorkflowId },
      safeSummary: `A signer was replaced on workflow ${scenticSignatureWorkflowId}`,
    });

    // No link where Scentic hosts the signing: OpenSign's page refuses the document.
    const signingUrl = doc.data.ScenticCeremony === true ? '' : signingUrlFor(this.config.publicUrl, doc.data.objectId, email, linked.data.objectId);
    return { success: true, data: { email, signingUrl } };
  }

  /**
   * Take a signature back before the document is complete, with any made after it. The document
   * returns to how it stood before that signature; those signers are asked again by the caller.
   */
  async revokeSignature(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    email: string,
    correlationId: string,
  ): Promise<ServiceResult<{ clearedEmails: string[] }>> {
    if (!email) return { success: false, error: invalidInput('email is required') };
    const doc = await this.documentFor(scenticFirmId, scenticSignatureWorkflowId);
    if (!doc.success) return doc;
    const closed = closedReason(doc.data);
    if (closed) return { success: false, error: conflict(closed.message) };

    const next = withSignatureRevoked(doc.data, email);
    if (isChangeError(next)) return { success: false, error: next.code === 'NOT_A_SIGNER' ? notFound(next.message) : conflict(next.message) };

    const saved = await this.client.updateDocument(doc.data.objectId, { SignedUrl: next.signedUrl, AuditTrail: next.auditTrail });
    if (!saved.success) return { success: false, error: wrapUpstreamError('OpenSign', 'updateDocument', saved.error) };

    await this.outbox.publish({
      eventType: 'OPENSIGN_SIGNATURE_REVOKED',
      scenticFirmId,
      correlationId,
      payload: { scenticSignatureWorkflowId, cleared: next.clearedEmails.length },
      safeSummary: `${next.clearedEmails.length} signature(s) taken back on workflow ${scenticSignatureWorkflowId}`,
    });

    return { success: true, data: { clearedEmails: next.clearedEmails } };
  }

  // ── Change when a request lapses ──────────────────────────────────────

  /**
   * Give the signers until another date.
   *
   * OpenSign decides a document has expired from one field, `ExpiryDate`, which it sets once when
   * the document is made (created + TimeToCompleteDays, in its after-save hook) and which its
   * signing page and this service's own status compare with now. Nothing recomputes it later, so
   * setting it is the whole change. TimeToCompleteDays is left alone: after creation it only
   * paces OpenSign's own reminders, and its before-save hook refuses a value that would mean more
   * than fifteen of them.
   *
   * A request that has already lapsed but is otherwise still out can be given more time; one that
   * is completed, declined or withdrawn cannot.
   */
  async changeExpiry(
    scenticFirmId: string,
    scenticSignatureWorkflowId: string,
    expiresAtInput: unknown,
    correlationId: string,
  ): Promise<ServiceResult<{ expiresAt: string }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }
    const field = (issue: string) => ({ success: false as const, error: invalidInput('Invalid request', [{ field: 'expiresAt', issue }]) });
    // A full date and time with its offset: "next Friday" in whose time zone is not ours to guess.
    if (typeof expiresAtInput !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(expiresAtInput.trim())) {
      return field('not an ISO 8601 date and time with a time zone');
    }
    const when = new Date(expiresAtInput.trim());
    if (Number.isNaN(when.getTime())) return field('not a date');
    if (when.getTime() <= Date.now()) return field('must be in the future');
    if (when.getTime() > Date.now() + 365 * 86_400_000) return field('at most 365 days from now');

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }
    if (mapping.opensignStatus === 'VOIDED') {
      return { success: false, error: invalidState('This request was withdrawn.') };
    }
    const docResult = await this.client.getDocument(mapping.opensignDocumentId);
    if (!docResult.success || !docResult.data) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'getDocument', docResult.error) };
    }
    const doc = docResult.data;
    if (!doc.objectId || doc.IsArchive) {
      return { success: false, error: invalidState('This request was withdrawn.') };
    }
    const closed = closedReason(doc);
    if (closed) return { success: false, error: invalidState(closed.message) };

    const expiresAt = when.toISOString();
    const saved = await this.client.updateDocument(doc.objectId, { ExpiryDate: { __type: 'Date', iso: expiresAt } });
    if (!saved.success) return { success: false, error: wrapUpstreamError('OpenSign', 'updateDocument', saved.error) };

    // A lapsed request was a finished one as far as polling goes; given more time, it is out again.
    if (mapping.opensignStatus === 'EXPIRED') {
      const status = deriveDocumentStatus({ ...doc, ExpiryDate: expiresAt });
      await this.store.updateOpenSignWorkflowStatus(scenticFirmId, scenticSignatureWorkflowId, status);
      await this.outbox.publish({
        eventType: 'OPENSIGN_WORKFLOW_STATUS_CHANGED',
        scenticFirmId,
        correlationId,
        payload: { scenticSignatureWorkflowId, opensignDocumentId: mapping.opensignDocumentId, oldStatus: 'EXPIRED', newStatus: status },
        safeSummary: `Workflow ${scenticSignatureWorkflowId} status changed from EXPIRED to ${status}`,
      });
    }
    return { success: true, data: { expiresAt } };
  }

  // ── Disable firm ──────────────────────────────────────────────────────

  async disableFirm(scenticFirmId: string, correlationId: string): Promise<ServiceResult<{ disabled: boolean }>> {
    await this.store.disableOpenSignFirmMapping(scenticFirmId);
    return { success: true, data: { disabled: true } };
  }

  // ── Test connection ───────────────────────────────────────────────────

  async testConnection(): Promise<ServiceResult<{ reachable: boolean }>> {
    const result = await this.client.getStatus();
    if (!result.success) {
      return { success: true, data: { reachable: false } };
    }
    return { success: true, data: { reachable: result.data!.reachable } };
  }
}
