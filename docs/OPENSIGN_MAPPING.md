# Scentic ↔ OpenSign Entity Mapping

**Status:** AGPL-00 planning document — not yet implemented.
**Scope:** Defines how Scentic core entities map to OpenSign entities through the AGPL gateway.
**Audience:** Gateway implementers, Scentic core integration engineers, security reviewers, release-gatekeeper.
**Upstream reference:** OpenSign (Parse Server), REST API at `/app/functions`, session-token auth, `contracts_Document` model, no native webhooks, completed PDFs via `SignedUrl`/`CertificateUrl` presigned URLs.

---

## 1. Mapping principles

1. **Scentic is the source of truth for documents, workflows, and participants.** OpenSign is the signing engine; once a workflow completes, the signed PDF and audit certificate return to Scentic and OpenSign's copy is deleted per retention policy.
2. **The gateway owns the mapping table, not Scentic core.** Scentic's `ProviderMapping` model is **not** used for AGPL integrations. The gateway stores `scenticEntityType, scenticEntityId, firmId, opensignEntityType, opensignEntityId, opensignTenantId` in its own encrypted-at-rest store.
3. **Firm isolation is via OpenSign tenants + ACLs.** Each Scentic Firm maps to an OpenSign `partners_Tenant` and a `contracts_Teams` team. Documents are created under the tenant and ACL-restricted to the team. The gateway never queries OpenSign without a tenant/team scope derived from the caller's `firmId`.
4. **Document content is sent to OpenSign only for signing.** OpenSign is not a document store. After completion + retrieval + `retentionDays`, the gateway deletes the document from OpenSign.
5. **No native webhooks.** OpenSign does not emit webhooks. The gateway must poll `getDocument` (or use a WebSocket subscription if available) to detect status changes, then emit signed webhooks to Scentic. This gap is first-class in the design.

## 2. Entity mapping overview

| Scentic entity | OpenSign entity | Cardinality | Sync direction | Storage of mapping |
|----------------|-----------------|-------------|----------------|--------------------|
| Firm | `partners_Tenant` + `contracts_Teams` | 1:1 | Scentic → OpenSign | Gateway mapping table |
| User | `contracts_Users` (with session token) | 1:1 | Scentic → OpenSign | Gateway mapping table (token encrypted) |
| Matter | Document metadata/context (not a direct entity) | 1:many | Scentic → OpenSign (as metadata) | Embedded in document `Name`/metadata |
| DocumentVersion / PhysicalFile | `contracts_Document` (uploaded PDF) | 1:1 per workflow | Scentic → OpenSign (upload) → Scentic (signed PDF return) | Gateway mapping table |
| SignatureWorkflow | OpenSign signing workflow | 1:1 | Bidirectional | Gateway mapping table keyed by `scenticWorkflowId` |
| SignatureParticipant | `Signers` array on `contracts_Document` | 1:1 | Scentic → OpenSign | Embedded in document |
| OpenSign completed PDF | Scentic `SIGNED_EXECUTION` PhysicalFile | 1:1 | OpenSign → Scentic | Scentic stores under same DocumentVersion (no version increment) |
| OpenSign audit certificate | Scentic signature event history | 1:1 | OpenSign → Scentic | Scentic stores as audit artifact |

## 3. Firm → OpenSign Tenant + Team

### 3.1 Field mapping

| Scentic `Firm` field | OpenSign entity/field | Notes |
|----------------------|-----------------------|-------|
| `id` (UUID) | — (gateway mapping) | Never sent to OpenSign as a field. |
| `name` | `partners_Tenant.name` + `contracts_Teams.name` | Sanitized. |
| `active` | — (controls gateway calls) | Tenant is disabled, not deleted, on offboard. |
| — | `contracts_Teams.members` | Set of OpenSign user ids belonging to this Firm. |

### 3.2 Lifecycle

- **Create:** `POST /admin/init-firm` → gateway creates an OpenSign `partners_Tenant` and a `contracts_Teams` team named `sanitized(firmName)`, stores `firmId → opensignTenantId, opensignTeamId` mapping, and provisions a per-Firm session token stored encrypted.
- **Update:** Firm rename updates the tenant and team names (rate-limited).
- **Disable:** `POST /admin/disable-firm` → gateway flips mapping to `disabled`, revokes the per-Firm session token, and disables the OpenSign tenant. OpenSign data is **not** deleted unless `deleteUpstreamData=true` with confirmation.
- **Re-enable:** Admin action + re-init with a new session token.

### 3.3 Authorization rules

- The OpenSign tenant id is the Firm isolation boundary. Every document created by the gateway is created under the mapped tenant. Every document query includes a tenant/team scope filter.
- The gateway post-filters every OpenSign response to ensure the returned document's tenant matches the caller's `firmId → opensignTenantId`. Mismatched objects are dropped and logged as `opensign.scope.leak` (security event).
- A tenant maps to exactly one Scentic Firm and vice versa.

## 4. User → OpenSign User

### 4.1 Field mapping

| Scentic `User` field | OpenSign `contracts_Users` field | Notes |
|----------------------|----------------------------------|-------|
| `id` (UUID) | — (gateway mapping) | Never sent to OpenSign as a field. |
| `email` | `email` | Required; must be unique within the OpenSign instance. |
| `firstName` + `lastName` | `name` | Combined. |
| `active` | — (controls gateway calls + team membership) | Disabled users removed from the Firm's team. |
| — | `sessionToken` | Per-user OpenSign session token, provisioned by the gateway, stored encrypted. Used for all document operations attributed to this user. |

### 4.2 Lifecycle

- **Create:** Gateway creates an OpenSign `contracts_Users`, adds to the Firm's `contracts_Teams`, provisions a session token, stores mapping.
- **Update:** Name/email changes propagate.
- **Remove from Firm:** Gateway removes the OpenSign user from the Firm's team. The OpenSign user account is **not** deleted (it may belong to other Firms in a shared OpenSign instance). The per-Firm session token is revoked.
- **Deactivate in Scentic:** Gateway revokes all session tokens for that user and removes from all OpenSign teams.

### 4.3 Authorization rules

- An OpenSign user is a member of exactly the OpenSign teams for the Scentic Firms they belong to.
- Document operations use the mapped user's session token, not a shared master token. This preserves OpenSign's per-user audit and limits blast radius (see threat model: `OPENSIGN_MASTER_KEY` compromise).
- The gateway refuses to create a workflow for a user not on the Firm's OpenSign team (`403 FIRM_SCOPE_VIOLATION`).

## 5. Matter → OpenSign document metadata (not a direct entity)

OpenSign has no "matter" or "project" entity. Matter context is attached to each document as metadata.

### 5.1 Field mapping

| Scentic `Matter` field | OpenSign location | Notes |
|------------------------|-------------------|-------|
| `id` (UUID) | `contracts_Document.metadata.scenticMatterId` (custom field) | Stored as metadata only; not used for OpenSign ACL. |
| `name` | Document `Name` prefix or metadata `scTitle` | **Sanitized.** The document `Name` is visible in OpenSign UI and email notifications; see threat model. A per-Firm policy may replace the matter name with a code in the `Name`. |
| `clientId` | `contracts_Document.metadata.scenticClientId` | Metadata only. |
| `firmId` | `contracts_Document.metadata.scenticFirmId` + tenant scope | Tenant scope is the real isolation. |

### 5.2 What is NOT sent to OpenSign

- Matter parties, opposing counsel, privileged notes, documents other than the one being signed, matter description, conflict info, custom Scentic matter fields.

### 5.3 Authorization rules

- Matter metadata is for Scentic's own correlation only. OpenSign ACLs are based on tenant/team, never on matter metadata. The gateway never relies on `metadata.scenticMatterId` for isolation.

## 6. DocumentVersion / PhysicalFile → OpenSign contracts_Document

### 6.1 Field mapping

| Scentic field | OpenSign `contracts_Document` field | Notes |
|----------------|--------------------------------------|-------|
| `DocumentVersion.id` | `metadata.scenticDocumentVersionId` | Metadata for correlation. |
| `PhysicalFile.id` | `metadata.scenticPhysicalFileId` | Metadata. |
| `PhysicalFile.fileName` | `Name` (combined with sanitized title) | The visible name. |
| `PhysicalFile.contentType` | — (must be `application/pdf`) | Gateway rejects non-PDF. |
| `PhysicalFile.sha256` | `metadata.scenticSha256` | Gateway verifies uploaded PDF hash matches before sending. |
| `PhysicalFile.sizeBytes` | — (validated, not stored as field) | Gateway rejects if mismatch with actual bytes. |
| `PhysicalFile.content` (bytes) | `File` (uploaded to OpenSign storage) | Sent only for signing. |
| `SignatureWorkflow.id` | `metadata.scenticWorkflowId` | Correlation. |

### 6.2 What is NOT sent to OpenSign

- Other versions of the same document, document lineage, prior signatures on the same document version, internal review comments, privileged annotations, anything not required to present the PDF for signing.

### 6.3 Lifecycle

- **Upload:** `POST /opensign/firm/{firmId}/workflows` → gateway uploads the PDF to OpenSign as a new `contracts_Document` under the Firm's tenant, creates the signer array, and (if `sendNow=true`) sends.
- **During signing:** The document lives in OpenSign storage. The gateway polls `getDocument` for status.
- **On completion:** The gateway retrieves the signed PDF and certificate (see §9), delivers them to Scentic, and schedules deletion of the OpenSign document after `retentionDays`.
- **Deletion:** After `retentionDays` (default 30), the gateway deletes the `contracts_Document` and its file storage. Deletion is verified by a follow-up `getDocument` returning not-found.

### 6.4 Authorization rules

- The document is created under the Firm's tenant. OpenSign ACLs restrict read/write to the Firm's team + the signers (who receive signer-specific access tokens).
- The gateway verifies the document's tenant on every read/write.
- Signers receive access only to the document they are invited to sign, via OpenSign's per-signer URL. They cannot list other documents in the tenant.

## 7. SignatureWorkflow → OpenSign signing workflow

### 7.1 Field mapping

| Scentic `SignatureWorkflow` field | OpenSign concept | Notes |
|------------------------------------|------------------|-------|
| `id` (UUID) | — (gateway mapping as `scenticWorkflowId`) + `metadata.scenticWorkflowId` | Correlation. |
| `status` | `contracts_Document.signUrl` state + signer statuses | Gateway derives an aggregate status. |
| `providerType` | `OPENSIGN` | Scentic enum. |
| `expiresAt` | `contracts_Document.ExpiryDate` | Optional. |
| `createdAt` / `updatedAt` | `createdAt` / `updatedAt` | OpenSign-managed. |
| — | `contracts_Document.IsCompleted` | OpenSign boolean. |
| — | `contracts_Document.IsDeclined` | OpenSign boolean. |
| — | `contracts_Document.IsExpired` | OpenSign boolean. |

### 7.2 Status mapping

| Scentic workflow status | OpenSign-derived state | Notes |
|-------------------------|------------------------|-------|
| `DRAFT` | Document created, not sent. | `sendNow=false`. |
| `SENT` | Document sent, no signer has acted. | All signers `SENT`. |
| `IN_PROGRESS` | At least one signer viewed/signed, not all complete. | Mixed signer statuses. |
| `COMPLETED` | `IsCompleted=true`; all signers `SIGNED`. | Signed PDF + certificate available. |
| `DECLINED` | `IsDeclined=true` or any signer `DECLINED`. | |
| `EXPIRED` | `IsExpired=true` or past `ExpiryDate`. | |
| `VOIDED` | Gateway called cancel; document voided. | |
| `FAILED` | Upstream error or signature verification failure. | |

### 7.3 Lifecycle

- **Create + send:** `POST /opensign/firm/{firmId}/workflows` with `sendNow=true`.
- **Status query:** `GET /.../status` returns the aggregate status by reading the OpenSign document + signer records.
- **Remind / cancel / delegate:** Corresponding gateway endpoints map to OpenSign functions (`sendReminder`, `cancelDocument`, `delegateSigner`).
- **Complete:** On detecting `IsCompleted=true` (via polling/WebSocket), the gateway retrieves the signed PDF + certificate, verifies signature integrity, emits `opensign.workflow.completed` webhook to Scentic with short-lived download URLs, then schedules OpenSign-side deletion after `retentionDays`.

## 8. SignatureParticipant → OpenSign Signers array

### 8.1 Field mapping

| Scentic `SignatureParticipant` field | OpenSign `Signers[]` field | Notes |
|---------------------------------------|-----------------------------|-------|
| `id` (UUID) | `metadata.scenticParticipantId` (per signer) | Correlation; OpenSign assigns its own signer id. |
| `email` | `Signers[].email` | Required by OpenSign. |
| `name` | `Signers[].name` | Required. |
| `role` | `Signers[].role` | Maps to OpenSign signer role. |
| `order` | `Signers[].order` | Routing order. |
| `status` | Derived from OpenSign signer status | Gateway reads and maps. |
| `redirectUrl` | `Signers[].redirectUrl` | Post-sign redirect. |

### 8.2 Role mapping

| Scentic role | OpenSign role | Notes |
|--------------|---------------|-------|
| `SIGNER` | `SIGNER` | Must sign. |
| `CC` | `CC` / `gets_copy` | Receives a copy, no signature. |
| `APPROVER` | `APPROVER` | Approves without signing. |
| `WITNESS` | `WITNESS` (if supported) | Falls back to `SIGNER` if OpenSign lacks witness role. |

### 8.3 Authorization rules

- Signer access is via OpenSign's per-signer URL/token. A signer can access only the document they were invited to.
- The gateway never exposes signer session tokens to Scentic. Scentic receives only signer statuses and emails it already owns.
- Adding a signer after send requires the gateway to update the OpenSign document's signer array; the gateway verifies the new signer's email is on the Firm's allowed list (if configured).

## 9. Completed PDF → Scentic SIGNED_EXECUTION PhysicalFile

This is the critical return path. The signed PDF must land in Scentic as a `SIGNED_EXECUTION` `PhysicalFile` on the **same** `DocumentVersion` (no version increment), per Scentic's signature workflow contract.

### 9.1 Retrieval flow

1. Gateway detects `IsCompleted=true` via polling `getDocument` (default interval 30s) or WebSocket.
2. Gateway calls OpenSign to obtain the presigned `SignedUrl` (S3: 160s TTL; local storage: 200s TTL) for the signed PDF and `CertificateUrl` for the audit certificate.
3. Gateway fetches the PDF bytes within the TTL window and stores them in a temporary gateway-side location (encrypted at rest, max retention 24h, deleted after delivery or TTL).
4. Gateway **verifies** the signed PDF's signature/certificate integrity (PDF signature validation + certificate chain check). On failure: `422 SIGNED_PDF_INVALID`, no delivery, security event `opensign.pdf.invalid`.
5. Gateway emits `opensign.workflow.completed` webhook to Scentic with short-lived (default 5 min) gateway download URLs for the signed PDF and certificate.
6. Scentic fetches the bytes via `GET /opensign/firm/{firmId}/workflows/{workflowId}/download` and `.../certificate` within the URL TTL.
7. Scentic stores the signed PDF as a `SIGNED_EXECUTION` `PhysicalFile` on the same `DocumentVersion` (no version increment) and the certificate in signature event history.
8. Gateway confirms Scentic acknowledgement (2xx on webhook) and schedules OpenSign-side document deletion after `retentionDays`.

### 9.2 Field mapping (return)

| OpenSign field | Scentic entity/field | Notes |
|----------------|-----------------------|-------|
| Signed PDF bytes | `PhysicalFile.content` (role `SIGNED_EXECUTION`) | Same `DocumentVersion` as the source. |
| Signed PDF `sha256` | `PhysicalFile.sha256` | Gateway computes and forwards. |
| `CertificateUrl` PDF bytes | Signature event history `auditCertificate` | Stored as audit artifact. |
| Signer statuses + timestamps | Signature event history entries | Per-signer events. |
| `completedAt` | `SignatureWorkflow.completedAt` | |

### 9.3 No version increment

The signed PDF is a new `PhysicalFile` on the **existing** `DocumentVersion`, not a new `DocumentVersion`. Scentic's domain model treats the signed execution as a physical artifact of the same logical version. The gateway must not signal Scentic to increment the version; the `opensign.workflow.completed` webhook carries `scenticDocumentVersionId` (unchanged) and `scenticPhysicalFileId` (the new signed artifact's id is assigned by Scentic, not the gateway).

## 10. Audit certificate → Scentic signature event history

### 10.1 Field mapping

| OpenSign field | Scentic location | Notes |
|----------------|------------------|-------|
| `CertificateUrl` (PDF) | Signature event history `auditCertificate` (file) | Stored as artifact. |
| Per-signer `signedAt` | Signature event history `signedAt` | Per participant. |
| Per-signer `ip` (if captured) | Signature event history `signerIp` | Optional; subject to privacy policy. |
| Per-signer `userAgent` (if captured) | Signature event history `userAgent` | Optional. |
| Document `completedAt` | Signature event history `completedAt` | |

### 10.2 What is NOT retained in Scentic

- OpenSign internal object ids beyond what is needed for correlation (already in gateway mapping).
- OpenSign instance metadata not relevant to the audit trail.

## 11. Webhook gap: OpenSign has no native webhooks

OpenSign does not emit webhooks on status changes. The gateway must synthesize them.

### 11.1 Polling approach (default)

- The gateway maintains a list of active (non-terminal) workflows per Firm.
- Every `OPENSIGN_POLL_INTERVAL_MS` (default 30000ms), the gateway calls OpenSign `getDocument` for each active workflow.
- On a status change (signer signed, declined, completed, expired), the gateway emits the corresponding `opensign.workflow.*` webhook to Scentic (see API_CONTRACTS.md §6.4.1).
- Polling stops for a workflow once it reaches a terminal status (`COMPLETED`, `DECLINED`, `EXPIRED`, `VOIDED`, `FAILED`).
- Polling cost scales with active workflow count. For high-volume Firms, the WebSocket approach is preferred.

### 11.2 WebSocket approach (if available)

- If the OpenSign deployment supports a WebSocket endpoint for document events, the gateway subscribes per tenant and emits webhooks on events.
- This is preferred for low-latency and lower cost at scale, but is optional because not all OpenSign deployments expose it.

### 11.3 Hybrid

- The gateway may use WebSocket where available and fall back to polling for workflows where WebSocket events are missed (a polling sweep every N minutes as a safety net).

### 11.4 Implications

- **Latency:** Status changes reach Scentic with up to `POLL_INTERVAL` latency by default.
- **At-least-once:** Webhooks are delivered at-least-once; Scentic must deduplicate by `X-Idempotency-Key`.
- **Audit:** The gateway logs each poll cycle and each emitted webhook.

## 12. Completed PDF retrieval: presigned URLs

- OpenSign returns presigned URLs for the signed PDF (`SignedUrl`) and audit certificate (`CertificateUrl`).
- **S3 storage:** TTL 160 seconds.
- **Local filesystem storage:** TTL 200 seconds.
- The gateway must fetch the bytes within the TTL. If the URL expires before fetch, the gateway requests a fresh URL.
- The gateway stores fetched bytes in a temporary encrypted location (TTL 24h) and exposes them to Scentic via short-lived gateway download URLs (default 5 min), authenticated by the service token.
- After Scentic fetches (or after 24h), the temporary copy is wiped.
- The gateway never re-exposes OpenSign's presigned URL directly to Scentic; Scentic always fetches through the gateway so the gateway can enforce scope and audit.

## 13. Cleanup rules

- **Document deletion:** After a workflow reaches `COMPLETED` (or a terminal state) and the signed PDF + certificate have been delivered to Scentic, the gateway schedules deletion of the OpenSign `contracts_Document` and its file storage after `retentionDays` (default 30, configurable per Firm).
- **Forced cleanup:** A Firm admin may force immediate deletion via an admin endpoint (out of scope for v1; tracked as AGPL-01 candidate).
- **Verification:** After deletion, the gateway verifies via `getDocument` returning not-found. If the document still exists, the gateway retries deletion with backoff and alerts.
- **Failed workflows:** Voided/declined/expired workflows are also deleted after `retentionDays` (no signed PDF to return).
- **Tenant disable:** On Firm offboard, all remaining documents for the tenant are deleted (with `deleteUpstreamData=true` confirmation) or locked (without).
- **Temporary gateway storage:** Fetched PDF bytes are wiped after delivery or 24h, whichever is first.
- **Audit:** Each deletion is logged as `opensign.document.deleted` with `{firmId, workflowId, documentId, sha256}`.

## 14. Data minimization rules

| Data category | Sent to OpenSign? | Reason |
|----------------|-------------------|--------|
| Firm name | Yes (sanitized, as tenant/team name) | Required for tenant. |
| User email, name | Yes | Required for OpenSign user + signer. |
| Matter name | Yes, **sanitized and optionally replaced with a code** in the document `Name` | Document name is visible in OpenSign UI and email notifications; high-risk. |
| Matter parties, opposing counsel, notes | **No** | Not needed for signing. |
| Document PDF content | Yes, for signing only | Deleted after retention. |
| Other document versions | **No** | Not needed. |
| Signer email, name, role | Yes | Required for signer routing. |
| Signer phone, address, other PII | **No** | Not needed. |
| Workflow expiry, order | Yes | Needed for routing. |
| Scentic internal ids | No (stored in gateway mapping + OpenSign metadata) | Not relevant to OpenSign. |
| Service tokens, session tokens, MASTER_KEY | No (used for auth only, never logged) | Secrets. |
| Audit certificate content | Returned to Scentic only | Not retained in OpenSign beyond retention. |

## 15. Authorization rules summary

1. **Tenant scoping:** Every OpenSign API call from the gateway is scoped by the caller's `firmId → opensignTenantId`. The gateway post-filters every response to ensure tenant match. Mismatch → drop + `opensign.scope.leak` security event.
2. **Team isolation:** An OpenSign team maps to exactly one Scentic Firm.
3. **Per-user session tokens:** Document operations use the mapped user's session token, not the master key. The master key is used only for tenant/user provisioning during init.
4. **Signer access:** Signers receive per-document access only; they cannot enumerate tenant documents.
5. **Completed PDF verification:** The gateway verifies signed PDF integrity before returning bytes to Scentic. Tampered PDFs are rejected (`422 SIGNED_PDF_INVALID`).

## 16. Mapping storage

- **Location:** Gateway-managed store (same as Kimai mapping; shared `gateway_mappings` table with an `opensign_entity_type` dimension, or a separate `gateway_opensign_mappings` table). **Not** Scentic's `ProviderMapping` table.
- **Schema (logical):**

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK. |
| `firm_id` | uuid | Scentic Firm id. |
| `scentic_entity_type` | enum (`FIRM`, `USER`, `DOCUMENT_VERSION`, `PHYSICAL_FILE`, `WORKFLOW`, `PARTICIPANT`) | |
| `scentic_entity_id` | uuid | Scentic entity id. |
| `opensign_entity_type` | enum (`TENANT`, `TEAM`, `USER`, `DOCUMENT`, `SIGNER`) | |
| `opensign_entity_id` | string | OpenSign object id. |
| `opensign_tenant_id` | string | Denormalized for fast scope checks. |
| `session_token_encrypted` | bytea | Nullable; per-user or per-Firm token, encrypted at rest. |
| `retention_days` | int | Per-workflow retention override. |
| `status` | enum (`ACTIVE`, `DISABLED`, `DELETED`, `PENDING_DELETION`) | |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | |
| `version` | int | Optimistic concurrency. |

- **Unique constraints:**
  - `(firm_id, scentic_entity_type, scentic_entity_id)`.
  - `(opensign_entity_type, opensign_entity_id)` — prevents cross-Firm aliasing.
- **Encryption:** Session tokens encrypted at rest with a KMS-managed key.

## 17. Open questions (AGPL-00)

- Whether the OpenSign deployment exposes a WebSocket events endpoint (affects polling vs. WebSocket choice).
- Default `retentionDays` (30 proposed) and whether it must be per-Firm configurable from day one.
- Whether matter names are sent as-is or replaced with codes by default (privacy vs. usability tradeoff for email notifications).
- Whether OpenSign captures signer IP/userAgent and whether Scentic's privacy policy permits retaining them.
- Exact OpenSign function names for `sendReminder`, `cancelDocument`, `delegateSigner` — to be confirmed against the vendor's current API.
- Whether one OpenSign instance is shared across Scentic tenants or one-per-tenant (affects user-email uniqueness and blast radius).
