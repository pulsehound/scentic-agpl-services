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

import { createHash } from 'node:crypto';
import type { OpenSignClient } from './opensign-client.js';
import type { MappingStore } from '../mappings/mapping-store.js';
import type { EventOutbox } from '../events/outbox.js';
import type {
  OpenSignDocument,
  OpenSignDocumentStatus,
  OpenSignHealthStatus,
  OpenSignResult,
} from './types.js';
import { deriveDocumentStatus } from './types.js';
import type {
  CreateOpenSignWorkflowParams,
  SyncOpenSignFirmParams,
  SyncOpenSignUserParams,
  OpenSignWorkflowMapping,
} from '../mappings/types.js';
import {
  notFound,
  firmScopeViolation,
  invalidInput,
  conflict,
  notSupported,
  upstreamUnavailable,
  wrapUpstreamError,
  type GatewayError,
} from '../http/errors.js';

export interface OpenSignServiceConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  completionTimeoutSeconds: number;
}

type ServiceResult<T> = { success: true; data: T } | { success: false; error: GatewayError };

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
    const docResult = await this.client.createDocument({
      name: params.documentName,
      url: uploadResult.data!.url,
      extUserPtr,
      signers: [],
      placeholders: params.signers.map(s => ({
        Role: s.role.toLowerCase(),
        email: s.email,
        placeHolder: [],
      })),
      timeToCompleteDays: 15,
      sendinOrder: false,
      isEnableOTP: false,
      notifyOnSignatures: true,
    });

    if (!docResult.success) {
      return { success: false, error: wrapUpstreamError('OpenSign', 'createDocument', docResult.error) };
    }

    const opensignDocId = docResult.data!.objectId;

    // Link signers to document
    for (const signer of params.signers) {
      const linkResult = await this.client.linkContactToDoc({
        docId: opensignDocId,
        email: signer.email,
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
      } else {
        const emailHash = createHash('sha256').update(signer.email).digest('hex');
        await this.store.upsertOpenSignSignerMapping(
          params.scenticFirmId,
          params.scenticSignatureWorkflowId,
          signer.scenticSignerId,
          linkResult.data!.objectId,
          emailHash,
        );
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

  async getWorkflowStatus(scenticFirmId: string, scenticSignatureWorkflowId: string, correlationId: string): Promise<ServiceResult<{ status: OpenSignDocumentStatus; opensignDocumentId: string; signers: Array<{ status: string; signedAt?: string }> }>> {
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

    // Extract signer statuses from audit trail
    const signers = (doc.AuditTrail || []).map(entry => ({
      status: entry.Activity,
      signedAt: entry.SignedOn,
    }));

    return { success: true, data: { status, opensignDocumentId: mapping.opensignDocumentId, signers } };
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

  async sendReminder(scenticFirmId: string, scenticSignatureWorkflowId: string, _signerIds: string[], correlationId: string): Promise<ServiceResult<{ remindedCount: number }>> {
    if (!this.config.enabled) {
      return { success: false, error: notSupported('OpenSign is not enabled') };
    }

    const mapping = await this.store.getOpenSignWorkflowMapping(scenticFirmId, scenticSignatureWorkflowId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return { success: false, error: notFound('Workflow not found') };
    }

    // OpenSign does not support manual reminders via API.
    // Automatic reminders are configured per-document.
    return { success: false, error: notSupported('OpenSign does not support manual reminders via API. Automatic reminders are configured per-document.') };
  }

  // ── Poll workflow ─────────────────────────────────────────────────────

  async pollWorkflow(scenticFirmId: string, scenticSignatureWorkflowId: string, correlationId: string): Promise<ServiceResult<{ status: OpenSignDocumentStatus; changed: boolean; completedPdfReady: boolean; certificateReady: boolean }>> {
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
      return { success: true, data: { status: mapping.opensignStatus as OpenSignDocumentStatus, changed: false, completedPdfReady: mapping.opensignStatus === 'COMPLETED', certificateReady: mapping.opensignStatus === 'COMPLETED' } };
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
