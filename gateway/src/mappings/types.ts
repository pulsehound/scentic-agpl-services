/**
 * Mapping types — Scentic entity ↔ Kimai entity mappings.
 *
 * All mappings are Firm-scoped. A Scentic user in two Firms has
 * separate UserMapping records. Cross-Firm mapping use is rejected.
 */

export type MappingStatus = 'ACTIVE' | 'DISABLED' | 'ERROR';

export interface FirmMapping {
  id: string;
  scenticFirmId: string;
  kimaiTeamId: number;
  kimaiTeamName: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UserMapping {
  id: string;
  scenticFirmId: string;
  scenticUserId: string;
  kimaiUserId: number;
  kimaiUsername: string;
  kimaiApiToken: string; // encrypted at rest in production
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ClientMapping {
  id: string;
  scenticFirmId: string;
  scenticClientId: string;
  kimaiCustomerId: number;
  displayLabelUsed: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MatterMapping {
  id: string;
  scenticFirmId: string;
  scenticMatterId: string;
  scenticClientId: string;
  kimaiProjectId: number;
  displayLabelUsed: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityMapping {
  id: string;
  scenticFirmId: string;
  scenticActivityCode: string;
  kimaiActivityId: number;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TimeEntryMapping {
  id: string;
  scenticFirmId: string;
  scenticTimeEntryId: string;
  kimaiTimesheetId: number;
  scenticMatterId: string;
  scenticUserId: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

// Sync request types

export interface SyncFirmParams {
  scenticFirmId: string;
  firmName: string;
}

export interface SyncUserParams {
  scenticFirmId: string;
  scenticUserId: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface SyncClientParams {
  scenticFirmId: string;
  scenticClientId: string;
  clientName: string;
}

export interface SyncMatterParams {
  scenticFirmId: string;
  scenticMatterId: string;
  scenticClientId: string;
  matterName: string;
  matterCode?: string;
}

export interface SyncActivityParams {
  scenticFirmId: string;
  scenticActivityCode: string;
  activityName: string;
}

export interface CreateTimeEntryParams {
  scenticFirmId: string;
  scenticUserId: string;
  scenticMatterId: string;
  scenticActivityCode: string;
  scenticTimeEntryId: string;
  startAt: string;
  endAt?: string;
  durationSeconds?: number;
  description?: string;
}

export interface UpdateTimeEntryParams {
  scenticFirmId: string;
  scenticTimeEntryId: string;
  startAt?: string;
  endAt?: string;
  durationSeconds?: number;
  description?: string;
}

export interface ListTimeEntriesParams {
  scenticFirmId: string;
  scenticUserId?: string;
  scenticMatterId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
}

export interface ExportTimeEntriesParams {
  scenticFirmId: string;
  scenticUserId?: string;
  scenticMatterId?: string;
  startDate?: string;
  endDate?: string;
  format?: 'csv' | 'xlsx' | 'pdf';
}

// ── OpenSign mapping types ──────────────────────────────────────────────

export interface OpenSignFirmMapping {
  id: string;
  scenticFirmId: string;
  opensignTenantId: string;
  opensignTenantName: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OpenSignUserMapping {
  id: string;
  scenticFirmId: string;
  scenticUserId: string;
  opensignUserId: string;
  opensignEmail: string;
  opensignSessionToken: string; // encrypted at rest in production
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OpenSignDocumentMapping {
  id: string;
  scenticFirmId: string;
  scenticMatterId: string;
  scenticDocumentId: string;
  scenticDocumentVersionId: string;
  scenticPhysicalFileId: string;
  opensignDocumentId: string;
  opensignStatus: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OpenSignWorkflowMapping {
  id: string;
  scenticFirmId: string;
  scenticSignatureWorkflowId: string;
  scenticMatterId: string;
  scenticDocumentId: string;
  scenticDocumentVersionId: string;
  opensignDocumentId: string;
  opensignWorkflowId: string;
  opensignStatus: string;
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OpenSignSignerMapping {
  id: string;
  scenticFirmId: string;
  scenticSignatureWorkflowId: string;
  scenticSignerId: string;
  opensignSignerId: string;
  signerEmailHash: string; // SHA-256 hash, never store raw email in logs
  status: MappingStatus;
  createdAt: string;
  updatedAt: string;
}

// OpenSign sync params

export interface SyncOpenSignFirmParams {
  scenticFirmId: string;
  firmName: string;
}

export interface SyncOpenSignUserParams {
  scenticFirmId: string;
  scenticUserId: string;
  email: string;
  name: string;
}

export interface CreateOpenSignWorkflowParams {
  scenticFirmId: string;
  scenticSignatureWorkflowId: string;
  scenticMatterId: string;
  scenticDocumentId: string;
  scenticDocumentVersionId: string;
  scenticPhysicalFileId: string;
  documentName: string;
  documentBase64: string;
  signers: Array<{
    scenticSignerId: string;
    email: string;
    name: string;
    role: string;
    order: number;
  }>;
  sendNow: boolean;
  /** Who the invitation says it is from. The firm, not the software. */
  senderName?: string;
}
