/**
 * Changing who signs a document after it has been sent, and taking a signature back.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * OpenSign keeps a document's signers in three places that have to agree: the placeholders (one
 * per signer, holding the address and the contact it is linked to), the Signers list (pointers to
 * those contacts), and the audit trail (one entry per contact: viewed, then signed — the signed
 * entry carrying the address of the PDF as it stood straight after that signature). Its signing
 * page finds a signer by the contact in their link, and counts the trail's signed entries against
 * the placeholders to decide the document is complete.
 *
 * These functions work out the new state of those fields. They are pure so that the rules — who
 * is cleared when a signature is taken back, what an old link may still do — can be tested without
 * an OpenSign to talk to.
 */

import type { OpenSignAuditEntry, OpenSignDocument, OpenSignPlaceholder, OpenSignSignerRef } from './types.js';
import { parseDate } from './types.js';

const SIGNED = new Set(['Signed', 'Approved']);
const NOT_SIGNING = new Set(['viewer', 'prefill']);

export type SignerState = 'pending' | 'viewed' | 'signed' | 'declined';

export interface SignerRow {
  email: string;
  role: string;
  /** 1-based, in the order the signers act. */
  order: number;
  state: SignerState;
  /** The contact the signer's link names. Never leaves this service. */
  contactId?: string;
}

function contactOf(placeholder: OpenSignPlaceholder): string | undefined {
  return placeholder.signerObjId ?? placeholder.signerPtr?.objectId ?? undefined;
}

type DeclineFields = Partial<Pick<OpenSignDocument, 'IsDeclined' | 'DeclineBy' | 'Signers'>>;

/**
 * The address of the signer who declined, or '' when nobody did or it cannot be told.
 *
 * OpenSign records a refusal on the document, not on the signer: `IsDeclined`, a reason, and
 * `DeclineBy` — the *account* that refused. Its audit trail gets no entry, so nothing in the trail
 * ever says "Declined" and a signer's own state could never read as declined. The account is tied
 * back to a signer through the Signers list, whose contacts each name their account.
 */
export function declinedByEmail(doc: Pick<OpenSignDocument, 'Placeholders'> & DeclineFields): string {
  if (!doc.IsDeclined) return '';
  const accountId = doc.DeclineBy?.objectId;
  const asked = new Map<string, string>();
  for (const p of doc.Placeholders ?? []) {
    const email = (p.email ?? '').trim().toLowerCase();
    if (!email) continue;
    asked.set(email, email);
    const contactId = contactOf(p);
    if (contactId) asked.set(`contact:${contactId}`, email);
  }
  if (accountId) {
    const contact = (doc.Signers ?? []).find((s) => s?.UserId?.objectId === accountId);
    if (contact) {
      const byContact = asked.get(`contact:${contact.objectId}`);
      if (byContact) return byContact;
      const byAddress = asked.get((contact.Email ?? '').trim().toLowerCase());
      if (byAddress) return byAddress;
    }
  }
  // The account's own address, where the read included it — only if it is somebody asked to sign.
  const own = (doc.DeclineBy?.email ?? doc.DeclineBy?.username ?? '').trim().toLowerCase();
  return asked.get(own) ?? '';
}

/** The people asked to sign or approve, in order, with where each has got to. */
export function signerRows(doc: Pick<OpenSignDocument, 'Placeholders' | 'AuditTrail'> & DeclineFields): SignerRow[] {
  const trail = doc.AuditTrail ?? [];
  const declined = declinedByEmail(doc);
  return (doc.Placeholders ?? [])
    .filter((p) => !NOT_SIGNING.has((p.Role ?? 'signer').toLowerCase()) && p.email)
    .map((placeholder, index) => {
      const contactId = contactOf(placeholder);
      const mine = contactId ? trail.filter((entry) => entry.UserPtr?.objectId === contactId) : [];
      const address = (placeholder.email ?? '').trim().toLowerCase();
      const state: SignerState = mine.some((e) => SIGNED.has(e.Activity))
        ? 'signed'
        : (declined !== '' && declined === address) || mine.some((e) => e.Activity === 'Declined')
          ? 'declined'
          : mine.some((e) => e.Activity === 'Viewed')
            ? 'viewed'
            : 'pending';
      return {
        email: (placeholder.email ?? '').trim().toLowerCase(),
        role: (placeholder.Role ?? 'signer').toLowerCase(),
        order: index + 1,
        state,
        contactId,
      };
    });
}

export type ChangeError = { code: 'NOT_A_SIGNER' | 'ALREADY_SIGNED' | 'NOT_SIGNED' | 'ALREADY_ON_DOCUMENT' | 'CLOSED'; message: string };

/** Whether anything may still change on this document. */
export function closedReason(doc: Pick<OpenSignDocument, 'IsCompleted' | 'IsArchive' | 'IsDeclined'>): ChangeError | null {
  if (doc.IsCompleted) return { code: 'CLOSED', message: 'Everyone has signed this document.' };
  if (doc.IsArchive) return { code: 'CLOSED', message: 'This request was withdrawn.' };
  if (doc.IsDeclined) return { code: 'CLOSED', message: 'A signer declined this document.' };
  return null;
}

/**
 * Hand one signer's place to somebody else.
 *
 * The placeholder takes the new address and loses its contact, and the old contact leaves the
 * Signers list — so the old link names a contact the document no longer has, and the signing page
 * refuses it. Linking the new address afterwards (linkcontacttodoc) creates their contact and puts
 * it back in both places. Someone who has signed cannot be replaced: their signature is on the PDF.
 */
export function withSignerReplaced(
  doc: Pick<OpenSignDocument, 'Placeholders' | 'Signers' | 'AuditTrail'>,
  fromEmail: string,
  toEmail: string,
): { placeholders: OpenSignPlaceholder[]; signers: OpenSignSignerRef[]; oldContactId?: string } | ChangeError {
  const from = fromEmail.trim().toLowerCase();
  const to = toEmail.trim().toLowerCase();
  const placeholders = (doc.Placeholders ?? []).map((p) => ({ ...p }));
  const index = placeholders.findIndex((p) => (p.email ?? '').trim().toLowerCase() === from);
  if (index === -1) return { code: 'NOT_A_SIGNER', message: `${fromEmail} is not asked to sign this document.` };
  if (placeholders.some((p) => (p.email ?? '').trim().toLowerCase() === to)) {
    return { code: 'ALREADY_ON_DOCUMENT', message: `${toEmail} is already asked to sign this document.` };
  }
  const row = signerRows(doc).find((r) => r.email === from);
  if (row?.state === 'signed') {
    return { code: 'ALREADY_SIGNED', message: `${fromEmail} has already signed. Take their signature back first.` };
  }

  const oldContactId = contactOf(placeholders[index]!);
  const { signerObjId: _id, signerPtr: _ptr, ...rest } = placeholders[index]!;
  placeholders[index] = { ...rest, email: to };
  const signers = (doc.Signers ?? []).filter((s) => !oldContactId || s.objectId !== oldContactId);
  return { placeholders, signers, oldContactId };
}

/**
 * Take one signature back, before the document is complete.
 *
 * Every signed entry in the trail carries the PDF as it stood straight after that signature, so the
 * document can be returned to the moment before it: the last signature made earlier than the one
 * taken back names that PDF, and with none, the original stands. A signature made after the one
 * taken back was made on a PDF that carried it, so it cannot be kept either — it is cleared too, and
 * that signer is asked again. Cleared entries go back to "viewed", keeping when the document was
 * opened and from where, which stays true.
 */
export function withSignatureRevoked(
  doc: Pick<OpenSignDocument, 'Placeholders' | 'AuditTrail'>,
  email: string,
): { signedUrl: string | null; auditTrail: OpenSignAuditEntry[]; clearedEmails: string[] } | ChangeError {
  const target = email.trim().toLowerCase();
  const rows = signerRows(doc);
  const row = rows.find((r) => r.email === target);
  if (!row) return { code: 'NOT_A_SIGNER', message: `${email} is not asked to sign this document.` };

  const trail = doc.AuditTrail ?? [];
  const signedEntries = trail.filter((entry) => SIGNED.has(entry.Activity));
  const revoked = signedEntries.find((entry) => entry.UserPtr?.objectId === row.contactId);
  if (!revoked) return { code: 'NOT_SIGNED', message: `${email} has not signed yet, so there is no signature to take back.` };

  const at = (entry: OpenSignAuditEntry) => parseDate(entry.SignedOn)?.getTime();
  const cutoff = at(revoked);
  const cleared = new Set<OpenSignAuditEntry>([revoked]);
  for (const entry of signedEntries) {
    const when = at(entry);
    // Undated, it cannot be shown to come before; kept off the PDF to be safe.
    if (cutoff === undefined || when === undefined || when >= cutoff) cleared.add(entry);
  }

  const kept = signedEntries
    .filter((entry) => !cleared.has(entry))
    .sort((a, b) => (at(a) ?? 0) - (at(b) ?? 0));
  const signedUrl = kept.length > 0 ? kept[kept.length - 1]!.SignedUrl || null : null;

  const auditTrail = trail.map((entry) =>
    cleared.has(entry)
      ? {
          ...(entry.UserPtr ? { UserPtr: entry.UserPtr } : {}),
          Activity: 'Viewed',
          ViewedOn: entry.ViewedOn ?? entry.SignedOn,
          ...(entry.ipAddress ? { ipAddress: entry.ipAddress } : {}),
        }
      : entry,
  );

  const emailByContact = new Map(rows.filter((r) => r.contactId).map((r) => [r.contactId!, r.email]));
  const clearedEmails = [...cleared]
    .map((entry) => (entry.UserPtr?.objectId ? emailByContact.get(entry.UserPtr.objectId) : undefined))
    .filter((value): value is string => Boolean(value));

  return { signedUrl, auditTrail, clearedEmails };
}

export function isChangeError(value: unknown): value is ChangeError {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value && !('placeholders' in value) && !('auditTrail' in value);
}
