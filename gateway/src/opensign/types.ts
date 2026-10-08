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
  ExpiryDate?: ParseDateValue;
  TimeToCompleteDays?: number;
  Signers: OpenSignSignerRef[];
  /**
   * Who sent it. Present on the document OpenSign returns, and the correct
   * source for a later reminder — a reminder should come from whoever sent the
   * invitation, not from whichever user happened to be looked up at the time.
   */
  ExtUserPtr?: OpenSignSignerRef;
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

/**
 * What Scentic needs to know about one recipient, per status check.
 *
 * The email is what makes any of it usable: an audit entry names its signer by
 * an internal object id, so a status response without an address is a list of
 * events with nobody attached to them.
 *
 * The address they acted from is evidence. If receipt of a document is ever
 * disputed, "opened from 82.x.x.x at 14:02" is the record that answers it.
 */
export interface OpenSignSignerStatus {
  email?: string;
  status: string;
  signedAt?: string;
  viewedAt?: string;
  ipAddress?: string;
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
  ExpiryDate?: ParseDateValue;
}): OpenSignDocumentStatus {
  if (doc.IsCompleted) return 'COMPLETED';
  if (doc.IsDeclined) return 'DECLINED';
  if (doc.IsArchive) return 'VOIDED';
  const expiry = parseDate(doc.ExpiryDate);
  if (expiry && expiry < new Date() && !doc.IsCompleted) return 'EXPIRED';
  if (doc.SignedUrl) return 'IN_PROGRESS';
  return 'DRAFT';
}

/**
 * A date as Parse stores it: `{ __type: 'Date', iso }` on a document read back, a string or a
 * Date elsewhere. Read as a plain string it is "[object Object]", which made every expiry check
 * compare against an invalid date and a status request throw "Invalid time value".
 */
export type ParseDateValue = string | Date | { __type?: string; iso?: string };

export function parseDate(value: ParseDateValue | null | undefined): Date | null {
  if (!value) return null;
  const raw = typeof value === 'object' && !(value instanceof Date) ? value.iso : value;
  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}
