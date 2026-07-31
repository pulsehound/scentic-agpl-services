/**
 * OpenSign types — mirrors of OpenSign Parse Server entities.
 * Verified against vendor/opensign/ source code.
 */

export type OpenSignDocumentStatus =
  | 'DRAFT'
  | 'SENT'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'VOIDED'
  | 'FAILED';

export interface OpenSignDocument {
  objectId: string;
  Name: string;
  URL: string;
  SignedUrl?: string;
  CertificateUrl?: string;
  DocumentHash?: string;
  IsCompleted: boolean;
  IsDeclined: boolean;
  IsArchive: boolean;
  DeclineReason?: string;
  ExpiryDate?: string;
  TimeToCompleteDays?: number;
  Signers: OpenSignSignerRef[];
  Placeholders: OpenSignPlaceholder[];
  AuditTrail: OpenSignAuditEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface OpenSignSignerRef {
  objectId: string;
  __type: string;
  className: string;
}

export interface OpenSignPlaceholder {
  Role: string; // 'signer', 'approver', 'viewer', 'prefill'
  email?: string;
  signerObjId?: string;
  signerPtr?: OpenSignSignerRef;
  placeHolder?: Array<{
    pos: Array<{
      type: string;
      options?: Record<string, unknown>;
    }>;
  }>;
}

export interface OpenSignAuditEntry {
  UserPtr?: { objectId: string; __type: string; className: string };
  SignedUrl?: string;
  Activity: string; // 'Signed', 'Viewed', 'Created', 'Approved'
  ipAddress?: string;
  SignedOn?: string;
  ViewedOn?: string;
  Signature?: string;
}

export interface OpenSignContact {
  objectId: string;
  Name: string;
  Email: string;
  Phone?: string;
  JobTitle?: string;
  Company?: string;
  UserId?: { objectId: string; __type: string; className: string };
  TenantId?: { objectId: string; __type: string; className: string };
}

export interface OpenSignTenant {
  objectId: string;
  TenantName: string;
  EmailAddress: string;
  IsActive: boolean;
  Domain?: string;
  PfxFile?: { base64: string; password: string };
}

export interface OpenSignUser {
  objectId: string;
  username: string;
  email: string;
  sessionToken?: string;
}

export interface OpenSignExtendedUser {
  objectId: string;
  Name: string;
  Email: string;
  Phone?: string;
  JobTitle?: string;
  Company?: string;
  UserRole: string;
  TenantId?: { objectId: string; __type: string; className: string };
  UserId?: { objectId: string; __type: string; className: string };
  IsDisabled: boolean;
}

// Result types

export interface OpenSignResult<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface OpenSignHealthStatus {
  reachable: boolean;
  version?: string;
  appId?: string;
}

// Derive aggregate document status from OpenSign booleans/fields
export function deriveDocumentStatus(doc: {
  IsCompleted: boolean;
  IsDeclined: boolean;
  IsArchive: boolean;
  SignedUrl?: string;
  ExpiryDate?: string;
}): OpenSignDocumentStatus {
  if (doc.IsCompleted) return 'COMPLETED';
  if (doc.IsDeclined) return 'DECLINED';
  if (doc.IsArchive) return 'VOIDED';
  if (doc.ExpiryDate) {
    const expiry = new Date(doc.ExpiryDate);
    if (expiry < new Date() && !doc.IsCompleted) return 'EXPIRED';
  }
  if (doc.SignedUrl) return 'IN_PROGRESS';
  return 'DRAFT';
}
