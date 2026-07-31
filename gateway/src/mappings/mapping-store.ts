/**
 * In-memory mapping store for development.
 *
 * In production, this should be replaced with SQLite or Postgres.
 * The interface is designed to be swappable.
 *
 * Security:
 * - All lookups are Firm-scoped
 * - Cross-Firm mapping use is rejected
 * - All writes are auditable (via event outbox)
 */

import type {
  FirmMapping, UserMapping, ClientMapping, MatterMapping,
  ActivityMapping, TimeEntryMapping, MappingStatus,
  SyncFirmParams, SyncUserParams, SyncClientParams, SyncMatterParams,
  SyncActivityParams, CreateTimeEntryParams, UpdateTimeEntryParams,
  ListTimeEntriesParams,
  OpenSignFirmMapping, OpenSignUserMapping, OpenSignDocumentMapping,
  OpenSignWorkflowMapping, OpenSignSignerMapping,
  SyncOpenSignFirmParams, SyncOpenSignUserParams, CreateOpenSignWorkflowParams,
} from './types.js';

export interface MappingStore {
  // Firm
  getFirmMapping(scenticFirmId: string): FirmMapping | null;
  upsertFirmMapping(params: SyncFirmParams, kimaiTeamId: number, kimaiTeamName: string): FirmMapping;
  disableFirmMapping(scenticFirmId: string): void;

  // User
  getUserMapping(scenticFirmId: string, scenticUserId: string): UserMapping | null;
  upsertUserMapping(params: SyncUserParams, kimaiUserId: number, kimaiUsername: string, kimaiApiToken: string): UserMapping;
  disableUserMapping(scenticFirmId: string, scenticUserId: string): void;

  // Client
  getClientMapping(scenticFirmId: string, scenticClientId: string): ClientMapping | null;
  upsertClientMapping(params: SyncClientParams, kimaiCustomerId: number, displayLabel: string): ClientMapping;

  // Matter
  getMatterMapping(scenticFirmId: string, scenticMatterId: string): MatterMapping | null;
  upsertMatterMapping(params: SyncMatterParams, kimaiProjectId: number, displayLabel: string): MatterMapping;

  // Activity
  getActivityMapping(scenticFirmId: string, scenticActivityCode: string): ActivityMapping | null;
  upsertActivityMapping(params: SyncActivityParams, kimaiActivityId: number): ActivityMapping;

  // TimeEntry
  getTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): TimeEntryMapping | null;
  upsertTimeEntryMapping(params: CreateTimeEntryParams, kimaiTimesheetId: number): TimeEntryMapping;
  updateTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): void;
  deleteTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): void;
  listTimeEntryMappings(params: ListTimeEntriesParams): TimeEntryMapping[];

  // Utility
  clear(): void;

  // OpenSign Firm
  getOpenSignFirmMapping(scenticFirmId: string): OpenSignFirmMapping | null;
  upsertOpenSignFirmMapping(params: SyncOpenSignFirmParams, opensignTenantId: string, opensignTenantName: string): OpenSignFirmMapping;
  disableOpenSignFirmMapping(scenticFirmId: string): void;

  // OpenSign User
  getOpenSignUserMapping(scenticFirmId: string, scenticUserId: string): OpenSignUserMapping | null;
  upsertOpenSignUserMapping(params: SyncOpenSignUserParams, opensignUserId: string, opensignSessionToken: string): OpenSignUserMapping;

  // OpenSign Workflow
  getOpenSignWorkflowMapping(scenticFirmId: string, scenticSignatureWorkflowId: string): OpenSignWorkflowMapping | null;
  upsertOpenSignWorkflowMapping(params: CreateOpenSignWorkflowParams, opensignDocumentId: string, opensignWorkflowId: string, opensignStatus: string): OpenSignWorkflowMapping;
  updateOpenSignWorkflowStatus(scenticFirmId: string, scenticSignatureWorkflowId: string, opensignStatus: string): void;
  listOpenSignWorkflowMappings(scenticFirmId: string): OpenSignWorkflowMapping[];

  // OpenSign Signer
  getOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string): OpenSignSignerMapping | null;
  upsertOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string, opensignSignerId: string, signerEmailHash: string): OpenSignSignerMapping;
}

export class InMemoryMappingStore implements MappingStore {
  private firms = new Map<string, FirmMapping>();
  private users = new Map<string, UserMapping>(); // key: firmId:userId
  private clients = new Map<string, ClientMapping>(); // key: firmId:clientId
  private matters = new Map<string, MatterMapping>(); // key: firmId:matterId
  private activities = new Map<string, ActivityMapping>(); // key: firmId:activityCode
  private timeEntries = new Map<string, TimeEntryMapping>(); // key: firmId:entryId
  // OpenSign mappings
  private osFirms = new Map<string, OpenSignFirmMapping>();
  private osUsers = new Map<string, OpenSignUserMapping>(); // key: firmId:userId
  private osWorkflows = new Map<string, OpenSignWorkflowMapping>(); // key: firmId:workflowId
  private osSigners = new Map<string, OpenSignSignerMapping>(); // key: firmId:workflowId:signerId

  private userKey(firmId: string, userId: string): string { return `${firmId}:${userId}`; }
  private clientKey(firmId: string, clientId: string): string { return `${firmId}:${clientId}`; }
  private matterKey(firmId: string, matterId: string): string { return `${firmId}:${matterId}`; }
  private activityKey(firmId: string, activityCode: string): string { return `${firmId}:${activityCode}`; }
  private timeEntryKey(firmId: string, entryId: string): string { return `${firmId}:${entryId}`; }

  private now(): string { return new Date().toISOString(); }

  // ── Firm ──────────────────────────────────────────────────────────────
  getFirmMapping(scenticFirmId: string): FirmMapping | null {
    return this.firms.get(scenticFirmId) ?? null;
  }

  upsertFirmMapping(params: SyncFirmParams, kimaiTeamId: number, kimaiTeamName: string): FirmMapping {
    const existing = this.firms.get(params.scenticFirmId);
    const now = this.now();
    const mapping: FirmMapping = existing
      ? { ...existing, kimaiTeamId, kimaiTeamName, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          kimaiTeamId,
          kimaiTeamName,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.firms.set(params.scenticFirmId, mapping);
    return mapping;
  }

  disableFirmMapping(scenticFirmId: string): void {
    const mapping = this.firms.get(scenticFirmId);
    if (mapping) {
      mapping.status = 'DISABLED';
      mapping.updatedAt = this.now();
    }
  }

  // ── User ──────────────────────────────────────────────────────────────
  getUserMapping(scenticFirmId: string, scenticUserId: string): UserMapping | null {
    return this.users.get(this.userKey(scenticFirmId, scenticUserId)) ?? null;
  }

  upsertUserMapping(params: SyncUserParams, kimaiUserId: number, kimaiUsername: string, kimaiApiToken: string): UserMapping {
    const key = this.userKey(params.scenticFirmId, params.scenticUserId);
    const existing = this.users.get(key);
    const now = this.now();
    const mapping: UserMapping = existing
      ? { ...existing, kimaiUserId, kimaiUsername, kimaiApiToken, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          scenticUserId: params.scenticUserId,
          kimaiUserId,
          kimaiUsername,
          kimaiApiToken,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.users.set(key, mapping);
    return mapping;
  }

  disableUserMapping(scenticFirmId: string, scenticUserId: string): void {
    const mapping = this.users.get(this.userKey(scenticFirmId, scenticUserId));
    if (mapping) {
      mapping.status = 'DISABLED';
      mapping.updatedAt = this.now();
    }
  }

  // ── Client ────────────────────────────────────────────────────────────
  getClientMapping(scenticFirmId: string, scenticClientId: string): ClientMapping | null {
    return this.clients.get(this.clientKey(scenticFirmId, scenticClientId)) ?? null;
  }

  upsertClientMapping(params: SyncClientParams, kimaiCustomerId: number, displayLabel: string): ClientMapping {
    const key = this.clientKey(params.scenticFirmId, params.scenticClientId);
    const existing = this.clients.get(key);
    const now = this.now();
    const mapping: ClientMapping = existing
      ? { ...existing, kimaiCustomerId, displayLabelUsed: displayLabel, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          scenticClientId: params.scenticClientId,
          kimaiCustomerId,
          displayLabelUsed: displayLabel,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.clients.set(key, mapping);
    return mapping;
  }

  // ── Matter ────────────────────────────────────────────────────────────
  getMatterMapping(scenticFirmId: string, scenticMatterId: string): MatterMapping | null {
    return this.matters.get(this.matterKey(scenticFirmId, scenticMatterId)) ?? null;
  }

  upsertMatterMapping(params: SyncMatterParams, kimaiProjectId: number, displayLabel: string): MatterMapping {
    const key = this.matterKey(params.scenticFirmId, params.scenticMatterId);
    const existing = this.matters.get(key);
    const now = this.now();
    const mapping: MatterMapping = existing
      ? { ...existing, kimaiProjectId, displayLabelUsed: displayLabel, scenticClientId: params.scenticClientId, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          scenticMatterId: params.scenticMatterId,
          scenticClientId: params.scenticClientId,
          kimaiProjectId,
          displayLabelUsed: displayLabel,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.matters.set(key, mapping);
    return mapping;
  }

  // ── Activity ──────────────────────────────────────────────────────────
  getActivityMapping(scenticFirmId: string, scenticActivityCode: string): ActivityMapping | null {
    return this.activities.get(this.activityKey(scenticFirmId, scenticActivityCode)) ?? null;
  }

  upsertActivityMapping(params: SyncActivityParams, kimaiActivityId: number): ActivityMapping {
    const key = this.activityKey(params.scenticFirmId, params.scenticActivityCode);
    const existing = this.activities.get(key);
    const now = this.now();
    const mapping: ActivityMapping = existing
      ? { ...existing, kimaiActivityId, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          scenticActivityCode: params.scenticActivityCode,
          kimaiActivityId,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.activities.set(key, mapping);
    return mapping;
  }

  // ── TimeEntry ─────────────────────────────────────────────────────────
  getTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): TimeEntryMapping | null {
    return this.timeEntries.get(this.timeEntryKey(scenticFirmId, scenticTimeEntryId)) ?? null;
  }

  upsertTimeEntryMapping(params: CreateTimeEntryParams, kimaiTimesheetId: number): TimeEntryMapping {
    const key = this.timeEntryKey(params.scenticFirmId, params.scenticTimeEntryId);
    const existing = this.timeEntries.get(key);
    const now = this.now();
    const mapping: TimeEntryMapping = existing
      ? { ...existing, kimaiTimesheetId, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          scenticTimeEntryId: params.scenticTimeEntryId,
          kimaiTimesheetId,
          scenticMatterId: params.scenticMatterId,
          scenticUserId: params.scenticUserId,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.timeEntries.set(key, mapping);
    return mapping;
  }

  updateTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): void {
    const mapping = this.timeEntries.get(this.timeEntryKey(scenticFirmId, scenticTimeEntryId));
    if (mapping) {
      mapping.updatedAt = this.now();
    }
  }

  deleteTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): void {
    const mapping = this.timeEntries.get(this.timeEntryKey(scenticFirmId, scenticTimeEntryId));
    if (mapping) {
      mapping.status = 'DISABLED';
      mapping.updatedAt = this.now();
    }
  }

  listTimeEntryMappings(params: ListTimeEntriesParams): TimeEntryMapping[] {
    const all = Array.from(this.timeEntries.values()).filter(m =>
      m.scenticFirmId === params.scenticFirmId &&
      m.status === 'ACTIVE'
    );
    let filtered = all;
    if (params.scenticUserId) {
      filtered = filtered.filter(m => m.scenticUserId === params.scenticUserId);
    }
    if (params.scenticMatterId) {
      filtered = filtered.filter(m => m.scenticMatterId === params.scenticMatterId);
    }
    return filtered;
  }

  clear(): void {
    this.firms.clear();
    this.users.clear();
    this.clients.clear();
    this.matters.clear();
    this.activities.clear();
    this.timeEntries.clear();
    this.osFirms.clear();
    this.osUsers.clear();
    this.osWorkflows.clear();
    this.osSigners.clear();
  }

  // ── OpenSign Firm ─────────────────────────────────────────────────────
  getOpenSignFirmMapping(scenticFirmId: string): OpenSignFirmMapping | null {
    return this.osFirms.get(scenticFirmId) ?? null;
  }

  upsertOpenSignFirmMapping(params: SyncOpenSignFirmParams, opensignTenantId: string, opensignTenantName: string): OpenSignFirmMapping {
    const existing = this.osFirms.get(params.scenticFirmId);
    const now = this.now();
    const mapping: OpenSignFirmMapping = existing
      ? { ...existing, opensignTenantId, opensignTenantName, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          opensignTenantId,
          opensignTenantName,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.osFirms.set(params.scenticFirmId, mapping);
    return mapping;
  }

  disableOpenSignFirmMapping(scenticFirmId: string): void {
    const mapping = this.osFirms.get(scenticFirmId);
    if (mapping) {
      mapping.status = 'DISABLED';
      mapping.updatedAt = this.now();
    }
  }

  // ── OpenSign User ─────────────────────────────────────────────────────
  getOpenSignUserMapping(scenticFirmId: string, scenticUserId: string): OpenSignUserMapping | null {
    return this.osUsers.get(this.userKey(scenticFirmId, scenticUserId)) ?? null;
  }

  upsertOpenSignUserMapping(params: SyncOpenSignUserParams, opensignUserId: string, opensignSessionToken: string): OpenSignUserMapping {
    const key = this.userKey(params.scenticFirmId, params.scenticUserId);
    const existing = this.osUsers.get(key);
    const now = this.now();
    const mapping: OpenSignUserMapping = existing
      ? { ...existing, opensignUserId, opensignEmail: params.email, opensignSessionToken, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          scenticUserId: params.scenticUserId,
          opensignUserId,
          opensignEmail: params.email,
          opensignSessionToken,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.osUsers.set(key, mapping);
    return mapping;
  }

  // ── OpenSign Workflow ─────────────────────────────────────────────────
  getOpenSignWorkflowMapping(scenticFirmId: string, scenticSignatureWorkflowId: string): OpenSignWorkflowMapping | null {
    return this.osWorkflows.get(this.matterKey(scenticFirmId, scenticSignatureWorkflowId)) ?? null;
  }

  upsertOpenSignWorkflowMapping(params: CreateOpenSignWorkflowParams, opensignDocumentId: string, opensignWorkflowId: string, opensignStatus: string): OpenSignWorkflowMapping {
    const key = this.matterKey(params.scenticFirmId, params.scenticSignatureWorkflowId);
    const existing = this.osWorkflows.get(key);
    const now = this.now();
    const mapping: OpenSignWorkflowMapping = existing
      ? { ...existing, opensignDocumentId, opensignWorkflowId, opensignStatus, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId: params.scenticFirmId,
          scenticSignatureWorkflowId: params.scenticSignatureWorkflowId,
          scenticMatterId: params.scenticMatterId,
          scenticDocumentId: params.scenticDocumentId,
          scenticDocumentVersionId: params.scenticDocumentVersionId,
          opensignDocumentId,
          opensignWorkflowId,
          opensignStatus,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.osWorkflows.set(key, mapping);
    return mapping;
  }

  updateOpenSignWorkflowStatus(scenticFirmId: string, scenticSignatureWorkflowId: string, opensignStatus: string): void {
    const mapping = this.osWorkflows.get(this.matterKey(scenticFirmId, scenticSignatureWorkflowId));
    if (mapping) {
      mapping.opensignStatus = opensignStatus;
      mapping.updatedAt = this.now();
    }
  }

  listOpenSignWorkflowMappings(scenticFirmId: string): OpenSignWorkflowMapping[] {
    return Array.from(this.osWorkflows.values()).filter(
      m => m.scenticFirmId === scenticFirmId && m.status === 'ACTIVE',
    );
  }

  // ── OpenSign Signer ───────────────────────────────────────────────────
  getOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string): OpenSignSignerMapping | null {
    return this.osSigners.get(`${scenticFirmId}:${scenticSignatureWorkflowId}:${scenticSignerId}`) ?? null;
  }

  upsertOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string, opensignSignerId: string, signerEmailHash: string): OpenSignSignerMapping {
    const key = `${scenticFirmId}:${scenticSignatureWorkflowId}:${scenticSignerId}`;
    const existing = this.osSigners.get(key);
    const now = this.now();
    const mapping: OpenSignSignerMapping = existing
      ? { ...existing, opensignSignerId, signerEmailHash, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          scenticFirmId,
          scenticSignatureWorkflowId,
          scenticSignerId,
          opensignSignerId,
          signerEmailHash,
          status: 'ACTIVE' as MappingStatus,
          createdAt: now,
          updatedAt: now,
        };
    this.osSigners.set(key, mapping);
    return mapping;
  }
}
