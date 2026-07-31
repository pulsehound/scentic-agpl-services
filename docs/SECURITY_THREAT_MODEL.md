# Scentic ↔ AGPL Gateway Security Threat Model

**Status:** AGPL-00 planning document — not yet implemented.
**Scope:** Threat model for the integration between the proprietary Scentic core and the AGPL-licensed `scentic-agpl-services` gateway (Kimai time tracking + OpenSign e-signature).
**Audience:** Gateway implementers, Scentic core integration engineers, security reviewers, `security-auditor` droid, `release-gatekeeper`.
**Method:** Each threat is scored for severity and paired with proposed controls and proposed tests. Tests are mandatory evidence for gate closure; controls alone are not evidence.

---

## 0. Summary table

| ID | Threat | Severity | Primary vector | Key control |
|----|--------|----------|----------------|-------------|
| T-01 | Cross-Firm leakage via Kimai customer/project names | HIGH | Name collision / weak scoping | Team-scoped queries + post-filter + uniqueness constraint |
| T-02 | Cross-Firm leakage via OpenSign document titles/signers | HIGH | Title/signer visibility | Tenant scoping + sanitized titles + ACL isolation |
| T-03 | Webhook spoofing (forged gateway → Scentic) | CRITICAL | Forged HMAC | HMAC-SHA256 + constant-time verify + replay window |
| T-04 | Replay attacks (replayed API calls or webhooks) | HIGH | Captured request replay | Idempotency keys + timestamps + nonce window |
| T-05 | Stale mappings (Firm/user deleted in Scentic, active in Kimai/OpenSign) | HIGH | Drift | Reconciliation job + disable on detection |
| T-06 | Scentic user removed but still active in Kimai/OpenSign | HIGH | Drift | Reconciliation + token revocation on removal |
| T-07 | Firm offboarded but AGPL records still accessible | HIGH | Incomplete offboard | Disable-firm revokes tokens + disables tenant/team |
| T-08 | Direct access to Kimai/OpenSign bypassing gateway | HIGH | Credentials leak / open port | Network isolation + per-user tokens + IP allowlist |
| T-09 | External app email notifications leaking matter names | MEDIUM | Kimai/OpenSign emails | Sanitize names + disable notifications or use codes |
| T-10 | OpenSign completed PDF injection (tampered PDF) | CRITICAL | MitM / storage tamper | Signature verification before storage + sha256 check |
| T-11 | Kimai time entry injection (unauthorized entries) | HIGH | Stolen user token | Per-user tokens + scope checks + audit anomalies |
| T-12 | Overbroad service account in gateway | HIGH | Shared admin token | Per-Firm/per-user tokens + least privilege |
| T-13 | Source-offer exposes proprietary code or secrets | MEDIUM | Mis-scoped repo | Repo boundary review + secret scanning + no Scentic code |
| T-14 | Logs contain document contents/signers/matter names | HIGH | Log verbosity | Structured logging + redaction + hashed-only fields |
| T-15 | AGPL license contamination of Scentic proprietary repo | HIGH | Copy/paste AGPL code | Repo isolation + import scanning + license headers |
| T-16 | OpenSign MASTER_KEY compromise | CRITICAL | Key leak / overuse | Use only for provisioning + KMS + rotation + audit |

---

## T-01 Cross-Firm leakage through Kimai customer/project names

- **Severity:** HIGH
- **Description:** Kimai customers and projects are addressed by id and name. If the gateway ever queries Kimai by name (or fails to filter responses by team), a customer/project belonging to Firm A could be returned to Firm B. Customer/project names may also collide across Firms (e.g. two Firms both have a client "Acme Corp"), and a name-based lookup could return the wrong one.
- **Attack vector:**
  1. Attacker controls Firm B and sends a request whose mapped `clientId`/`matterId` resolves to a Kimai customer/project id.
  2. If the gateway's scope check is missing or bypassed (e.g. a code path that lists customers without a `teamId` filter), Firm B sees Firm A's customers/projects.
  3. Alternatively, a name-collision lookup returns Firm A's customer to Firm B.
- **Impact:** Disclosure of client identities and matter names across Firms. Violates the cross-Firm leakage invariant. Reputational and regulatory (attorney confidentiality).
- **Proposed controls:**
  1. Every Kimai API call from the gateway includes `teamId` (= the caller's `firmId → kimaiTeamId`) in the filter set. No unscoped queries.
  2. The gateway post-filters every Kimai response: any returned object whose team membership does not include the caller's team id is dropped and logged as `kimai.scope.leak` (security event).
  3. The mapping table enforces uniqueness: `(kimai_entity_type, kimai_entity_id)` maps to at most one `firm_id`. A Kimai customer/project cannot be aliased to two Firms.
  4. Lookups are by Kimai id (resolved from Scentic id via the mapping table), never by name. Name-based lookups are prohibited.
  5. Kimai customers/projects are restricted to a single team (the Firm's); the gateway rejects multi-team assignments.
- **Proposed tests:**
  - **Cross-Firm leakage test (negative authorization):** Create Firm A and Firm B in a test Kimai instance, each with a client and matter. As Firm B, attempt to read Firm A's time entries via the gateway with Firm A's `clientId`/`matterId` in the query. Assert `403 FIRM_SCOPE_VIOLATION` and that no Firm A data is returned.
  - **Name-collision test:** Create two Firms with identically named clients. Assert each Firm sees only its own client.
  - **Post-filter test:** Inject a Kimai customer assigned to two teams (simulating a misconfiguration). Assert the gateway drops it for the wrong Firm and logs `kimai.scope.leak`.
  - **Mutation test:** Remove the `teamId` filter from one gateway code path (mutation) and assert the leakage test fails (proves the test catches the regression).

## T-02 Cross-Firm leakage through OpenSign document titles/signers

- **Severity:** HIGH
- **Description:** OpenSign documents have a `Name` and a `Signers` array, both visible in the OpenSign UI and potentially in email notifications. If the gateway queries OpenSign without a tenant scope, or if a document's ACL is misconfigured, Firm B could see Firm A's document titles or signer emails.
- **Attack vector:**
  1. Attacker controls Firm B and calls a gateway endpoint that lists or fetches OpenSign documents.
  2. If the gateway fails to filter by `opensignTenantId`, or if a document was created under the wrong tenant, Firm B sees Firm A's document metadata.
  3. Alternatively, a signer URL from Firm A's document is leaked/brute-forced and used by Firm B.
- **Impact:** Disclosure of matter-related document titles and signer identities across Firms. Violates cross-Firm leakage invariant.
- **Proposed controls:**
  1. Every OpenSign API call from the gateway includes a tenant/team scope derived from `firmId → opensignTenantId`.
  2. The gateway post-filters every OpenSign response: any returned document whose tenant does not match is dropped and logged as `opensign.scope.leak`.
  3. Documents are created under the Firm's tenant with ACLs restricted to the Firm's team + the specific signers.
  4. Signer access is via OpenSign's per-signer URL/token; signers cannot enumerate tenant documents.
  5. Document `Name` is sanitized and may be replaced with a code per Firm policy (also mitigates T-09).
  6. The mapping table enforces uniqueness: an OpenSign document maps to at most one Firm.
- **Proposed tests:**
  - **Cross-Firm leakage test (OpenSign):** Create Firm A and Firm B, each with a workflow. As Firm B, attempt to read Firm A's workflow status and download URL. Assert `403`/`404` and no Firm A data.
  - **Tenant-mismatch test:** Inject a document under the wrong tenant (simulated misconfiguration). Assert the gateway drops it and logs `opensign.scope.leak`.
  - **Signer URL isolation test:** Attempt to use Firm A's signer URL from a Firm B context. Assert rejection by OpenSign ACLs.
  - **Mutation test:** Remove the tenant scope filter (mutation) and assert the leakage test fails.

> **AGPL-02 mitigation note:** T-02 is mitigated in the AGPL-02 implementation by the **firm-scoped mapping store** (`gateway/src/mappings/`). Every OpenSign workflow, signer, and tenant mapping is keyed by `firmId`, and the OpenSign service resolves `firmId → opensignTenantId` from the mapping before any upstream call. Cross-firm lookups are rejected at the mapping layer before the OpenSign client is reached, and the mapping store inherits the AGPL-01 cross-firm leakage prevention (a mapping for Firm A cannot be resolved from a Firm B context). Per-firm post-filtering of OpenSign responses (the planned control §1.2) is a carried gap for AGPL-04, once per-user session tokens and a persistent mapping store land.

## T-03 Webhook spoofing (forged gateway → Scentic webhooks)

- **Severity:** CRITICAL
- **Description:** The gateway sends signed webhooks to Scentic (`opensign.workflow.*`, `kimai.time.entry.*`). If an attacker can forge a webhook, they could inject a fake "workflow completed" event causing Scentic to mark a workflow complete without a real signature, or inject fake time-entry events.
- **Attack vector:**
  1. Attacker captures a valid webhook (or guesses the structure) and replays it with a modified payload (e.g. a different `workflowId` marked `COMPLETED`).
  2. If Scentic does not verify the HMAC, or verifies it with a non-constant-time compare, or accepts an unsigned webhook, the forged event is processed.
- **Impact:** Forged completion of a signature workflow (Scentic stores a non-existent signed PDF as `SIGNED_EXECUTION`), or forged time-entry state. Catastrophic for legal integrity.
- **Proposed controls:**
  1. All webhooks are signed with `GATEWAY_WEBHOOK_SECRET` using HMAC-SHA256 over the canonical body. Header: `X-Gateway-Signature: sha256=<hex>`.
  2. Scentic verifies the signature in constant time and rejects mismatches with `401`. Verification failure is a security event.
  3. The webhook secret is distinct from the service token and rotated independently.
  4. Webhook payloads include `eventTimestamp`; Scentic rejects events older than a configurable window (default 5 min) to bound replay (see T-04).
  5. The webhook secret is never sent over the wire; only the HMAC is.
  6. The webhook receiver route on Scentic is the only route that accepts gateway webhooks; it is not exposed as a generic public endpoint.
- **Proposed tests:**
  - **Spoofed-signature test:** Send a webhook with a wrong HMAC. Assert Scentic rejects with `401` and does not process the event.
  - **Missing-signature test:** Send a webhook with no `X-Gateway-Signature`. Assert rejection.
  - **Tampered-payload test:** Take a valid webhook, flip one byte in the body, keep the old signature. Assert rejection.
  - **Constant-time test:** Verify the signature comparison is constant-time (timing analysis or code inspection + property test).
  - **Replay test:** Replay a valid webhook after the timestamp window. Assert rejection (see T-04).
  - **Forged-completion test:** Attempt to forge an `opensign.workflow.completed` event for a workflow that is not actually completed in OpenSign. Assert Scentic rejects (because no signed PDF can be fetched from the gateway) and the workflow remains non-complete.

## T-04 Replay attacks (replayed API calls or webhooks)

- **Severity:** HIGH
- **Description:** An attacker captures a valid API request or webhook and replays it later. For idempotent operations this is usually harmless, but for non-idempotent-by-nature effects (e.g. a webhook marking a workflow complete, or an admin disable-firm call) replay could cause stale or duplicate state changes.
- **Attack vector:**
  1. Attacker captures a valid `POST /admin/disable-firm` request (or a webhook) off the wire.
  2. Replays it later to disable a Firm that was re-enabled, or to re-deliver a completed event.
- **Impact:** Stale state changes, duplicate processing, denial of service on a re-enabled Firm.
- **Proposed controls:**
  1. Side-effecting API requests require `X-Idempotency-Key`; the gateway caches the response for 24h and replays the original response on a cache hit (no re-execution). Reuse with a different body returns `409 IDEMPOTENCY_KEY_REUSE`.
  2. Webhook payloads include `eventTimestamp` and `eventVersion`; Scentic rejects events whose timestamp is outside a configurable window (default ±5 min) and deduplicates by `X-Idempotency-Key`.
  3. Admin operations (`disable-firm`, `rotate-secret`) are additionally gated by a short-lived confirmation token or a second factor for destructive variants.
  4. TLS in production prevents passive capture; replay is primarily an insider/endpoint threat.
- **Proposed tests:**
  - **API replay test:** Send a `POST` with idempotency key K, then replay with the same K and same body. Assert the same response is returned with `X-Idempotent-Replay: true` and no second side effect.
  - **API replay with different body test:** Replay key K with a different body. Assert `409 IDEMPOTENCY_KEY_REUSE`.
  - **Webhook replay test:** Deliver a valid webhook, then replay the exact same webhook. Assert Scentic deduplicates (processes once).
  - **Webhook stale-timestamp test:** Deliver a webhook with an `eventTimestamp` older than the window. Assert rejection.
  - **Disable-firm replay test:** Disable a Firm, re-enable it, then replay the original disable request. Assert it does not disable the re-enabled Firm (idempotency cache expired or conflict on current state).

## T-05 Stale mappings (Firm/user deleted in Scentic but still active in Kimai/OpenSign)

- **Severity:** HIGH
- **Description:** A Firm or user is deleted (or hard-deleted) in Scentic, but the gateway's mapping table and the upstream Kimai/OpenSign objects still exist and remain active. The upstream objects may still be accessible via direct upstream access (see T-08) or via a stale token.
- **Attack vector:**
  1. Firm A is deleted in Scentic. The deletion event is missed or the gateway is down.
  2. Firm A's Kimai team and OpenSign tenant remain active.
  3. Anyone with the (still-valid) per-Firm token, or with direct upstream access, can read Firm A's historical data.
- **Impact:** Persistent access to data of a deleted Firm/user. Violates deletion intent and retention policy.
- **Proposed controls:**
  1. Scentic → gateway lifecycle events (Firm/user delete) trigger immediate mapping disable + token revocation + upstream disable.
  2. A periodic reconciliation job (default hourly) compares the gateway's mapping table against Scentic's authoritative Firm/user list (via a Scentic-side endpoint or a snapshot). Any mapping whose Scentic entity no longer exists is disabled: tokens revoked, upstream team/tenant disabled.
  3. Reconciliation is idempotent and audited (`reconciliation.stale_mapping`).
  4. Hard-delete in Scentic triggers `deleteUpstreamData=true` flow in the gateway (with confirmation).
- **Proposed tests:**
  - **Reconciliation test:** Delete a Firm in Scentic without notifying the gateway (simulating a missed event). Run the reconciliation job. Assert the Firm's mapping is disabled, tokens revoked, and upstream team/tenant disabled.
  - **User-reconciliation test:** Delete a user in Scentic. Run reconciliation. Assert the user's mapping is disabled and tokens revoked.
  - **Missed-event test:** Take the gateway down, delete a Firm in Scentic, bring the gateway back up. Assert reconciliation catches it on next run.

## T-06 Scentic user removed but still active in Kimai/OpenSign

- **Severity:** HIGH
- **Description:** A user is removed from a Firm (or deactivated in Scentic) but their Kimai user/OpenSign user remains active and still holds a valid API/session token. They could continue to log time or access documents.
- **Attack vector:**
  1. User is removed from Firm A in Scentic. The removal event is missed.
  2. The user's Kimai API token and OpenSign session token remain valid.
  3. The user (or someone who captured the token) continues to create time entries or access documents.
- **Impact:** Unauthorized time entry creation (T-11) or document access after removal.
- **Proposed controls:**
  1. User removal from a Firm triggers immediate token revocation for that user in both Kimai and OpenSign + removal from the Firm's team.
  2. The reconciliation job (T-05) also covers user membership: any user in the gateway mapping who is no longer a member of the Firm in Scentic has their tokens revoked and is removed from the upstream team.
  3. Deactivation in Scentic revokes all of the user's tokens across all Firms.
  4. Kimai/OpenSign users disabled by the gateway have `enabled=false` so even a leaked token cannot be used (Kimai) / session is invalidated (OpenSign).
- **Proposed tests:**
  - **Removed-user access test:** Remove a user from a Firm, then attempt to create a time entry or open a document as that user via the gateway. Assert `403` (no longer on team).
  - **Token-revocation test:** After removal, attempt to use the user's Kimai API token directly against Kimai. Assert rejection (token revoked or user disabled).
  - **Reconciliation test:** Remove user in Scentic without notifying the gateway. Run reconciliation. Assert tokens revoked and user removed from upstream team.

## T-07 Firm offboarded but AGPL records still accessible

- **Severity:** HIGH
- **Description:** A Firm is offboarded in Scentic, but the AGPL-side Kimai team/OpenSign tenant remain enabled and accessible (e.g. because `disable-firm` only flipped a gateway flag without revoking upstream credentials).
- **Attack vector:**
  1. Firm offboard event calls `POST /admin/disable-firm` with `deleteUpstreamData=false`.
  2. The gateway flips its mapping flag but does not revoke the per-Firm upstream tokens or disable the upstream team/tenant.
  3. Anyone with the per-Firm token continues to access the upstream data.
- **Impact:** Post-offboard data access. Violates retention and offboarding policy.
- **Proposed controls:**
  1. `POST /admin/disable-firm` **always** revokes the per-Firm Kimai API token and OpenSign session token, regardless of `deleteUpstreamData`. The flag only controls whether upstream data is deleted vs. disabled.
  2. The upstream Kimai team is set to inactive and the OpenSign tenant is disabled.
  3. The gateway rejects all subsequent calls for a disabled Firm with `403 FIRM_DISABLED`.
  4. A verification step after disable confirms the upstream team/tenant is disabled; if not, the gateway retries and alerts.
  5. `deleteUpstreamData=true` requires a separate `X-Confirm-Delete` header and is audited at a higher severity.
- **Proposed tests:**
  - **Offboard-revokes-tokens test:** Offboard a Firm. Assert the per-Firm Kimai and OpenSign tokens are revoked (direct upstream use fails).
  - **Offboard-disables-upstream test:** After offboard, assert the Kimai team is inactive and the OpenSign tenant is disabled.
  - **Post-offboard-access test:** After offboard, attempt any gateway call for that Firm. Assert `403 FIRM_DISABLED`.
  - **Delete-without-confirmation test:** Call disable with `deleteUpstreamData=true` but no `X-Confirm-Delete`. Assert rejection.
  - **Re-enable-requires-admin test:** Attempt to call gateway routes for a disabled Firm after a normal (non-admin) re-enable. Assert still `403` until admin re-init completes.

## T-08 Direct access to Kimai/OpenSign bypassing the Scentic gateway

- **Severity:** HIGH
- **Description:** If Kimai or OpenSign is reachable on the network directly (open port, exposed UI), an attacker with a leaked token or default credentials can bypass the gateway's Firm-scoping and audit entirely.
- **Attack vector:**
  1. Kimai/OpenSign is deployed on a network reachable by non-gateway hosts.
  2. A per-user or per-Firm token leaks (logs, config, endpoint).
  3. Attacker uses the token directly against Kimai/OpenSign, bypassing gateway scope checks and audit.
- **Impact:** Unaudited access, potential cross-Firm access if the token is overbroad (T-12), data exfiltration.
- **Proposed controls:**
  1. Network isolation: Kimai and OpenSign are reachable only from the gateway (private network / firewall / security group). Their UIs are not exposed publicly.
  2. Per-user tokens (not a shared admin token) limit blast radius.
  3. Kimai/OpenSign admin endpoints are IP-allowlisted to the gateway only.
  4. Tokens are stored encrypted at rest in the gateway mapping store; never logged; rotated on schedule and on incident.
  5. The gateway audit log records every upstream call; direct upstream access (bypassing the gateway) is detectable by comparing upstream access logs against gateway audit logs (anomaly detection).
  6. Default credentials (Kimai admin, OpenSign master) are rotated at bootstrap and not used for routine operations.
- **Proposed tests:**
  - **Network-isolation test:** From a non-gateway host in the deployment, attempt to reach Kimai and OpenSign directly. Assert connection refused/blocked.
  - **Token-leak test:** Simulate a leaked per-user token and attempt direct upstream access. Assert the token works only for that user's scoped data (proves least privilege) and that the access appears in upstream logs but not the gateway audit (proves detectability).
  - **Admin-IP-allowlist test:** From a non-gateway IP, attempt to reach an admin endpoint. Assert rejection.

## T-09 External app email notifications leaking matter names

- **Severity:** MEDIUM
- **Description:** Kimai and OpenSign send email notifications (time entry summaries, signing invitations, reminders). These emails may include customer/project/document names that contain confidential matter information, leaking them to recipients who should not see the matter name (e.g. a signer's personal inbox, a billing contact).
- **Attack vector:**
  1. A signer receives an OpenSign email with the document `Name` = "NDA - ACQ-IND Acquisition" (a confidential matter).
  2. Or a Kimai email to a billing contact includes a project name with confidential info.
  3. The recipient's email account is compromised or the recipient is not authorized for that matter name.
- **Impact:** Disclosure of matter names to unauthorized recipients. Lower severity than cross-Firm leakage but still an attorney-confidentiality concern.
- **Proposed controls:**
  1. Document `Name` sent to OpenSign is sanitized and optionally replaced with a billing code per Firm policy (e.g. "Document for signature - REF-12345").
  2. Kimai project/customer names are sanitized (deny-list of confidential tokens).
  3. Where possible, email notifications are disabled (Kimai `MAILER_URL=null://null` in environments where Scentic handles notifications; OpenSign email disabled when Scentic sends its own invitations).
  4. Where emails must be sent, templates are reviewed to ensure only sanitized names appear.
  5. The gateway logs a warning if a Firm has notifications enabled and names are not sanitized.
- **Proposed tests:**
  - **Sanitized-name test:** Create a workflow with a confidential matter name. Assert the document `Name` stored in OpenSign is sanitized (does not contain the confidential token).
  - **Email-content test (staging):** Trigger an OpenSign email in a staging environment with mail capture. Assert the email body does not contain the unsanitized matter name.
  - **Notification-disabled test:** Verify that when `MAILER_URL=null://null`, Kimai sends no emails.
  - **Policy-enforcement test:** Configure a Firm with `requireCodeNames=true` and a confidential matter name. Assert the gateway rejects the real name and requires a code.

## T-10 OpenSign completed PDF injection (tampered PDF before storage)

- **Severity:** CRITICAL
- **Description:** Between OpenSign completing a workflow and Scentic storing the signed PDF, the PDF bytes could be tampered with (mitM on the presigned URL, tampering in gateway temporary storage, or a compromised OpenSign instance). Scentic would then store a tampered "signed" PDF as `SIGNED_EXECUTION`, undermining legal integrity.
- **Attack vector:**
  1. Attacker controls a hop between OpenSign storage and the gateway (or between the gateway and Scentic), or compromises the gateway's temporary storage.
  2. The signed PDF bytes are altered before Scentic stores them.
  3. Scentic stores the tampered PDF as the signed execution.
- **Impact:** A forged/tampered document is stored as the legally binding signed copy. Catastrophic for legal integrity.
- **Proposed controls:**
  1. The gateway verifies the signed PDF's signature/certificate integrity (PDF signature validation + certificate chain check) immediately after fetching from OpenSign and before exposing it to Scentic. On failure: `422 SIGNED_PDF_INVALID`, no delivery, security event `opensign.pdf.invalid`.
  2. The gateway computes and forwards `sha256` of the signed PDF; Scentic verifies the hash on receipt.
  3. The gateway → Scentic download endpoint is TLS-only in production.
  4. The gateway's temporary storage is encrypted at rest and wiped after delivery or 24h.
  5. The signed PDF is fetched by the gateway directly from OpenSign's presigned URL (not re-exposed to Scentic as the OpenSign URL), so Scentic never touches the OpenSign URL.
  6. The audit certificate is also verified and hashed before delivery.
- **Proposed tests:**
  - **Tampered-PDF test:** Substitute a tampered PDF in the gateway's temporary storage (simulated compromise). Assert the gateway's verification catches it, returns `422 SIGNED_PDF_INVALID`, and does not deliver to Scentic.
  - **Hash-mismatch test:** Flip a byte in the PDF after hash computation (simulated). Assert Scentic rejects on hash mismatch.
  - **Signature-validation test:** Present a PDF with a broken signature (simulated). Assert the gateway's validator rejects it.
  - **TLS test:** Attempt to fetch the download endpoint over plain HTTP in production mode. Assert rejection.
  - **Certificate-chain test:** Present a signed PDF whose certificate chain is broken. Assert rejection.

## T-11 Kimai time entry injection (unauthorized time entries created)

- **Severity:** HIGH
- **Description:** An attacker creates unauthorized time entries in Kimai (via a leaked user token or direct access) that then sync into Scentic as legitimate entries, inflating billable hours.
- **Attack vector:**
  1. Attacker obtains a user's Kimai API token (leak, logs, mitM).
  2. Attacker creates timesheets directly in Kimai for projects/activities in a Firm.
  3. The gateway's polling sync picks up the entries and emits `kimai.time.entry.created` webhooks.
  4. Scentic creates time entries from the webhooks, treating them as legitimate.
- **Impact:** Inflated billable hours, fraudulent billing, unauthorized activity attribution.
- **Proposed controls:**
  1. Per-user Kimai tokens (least privilege) limit the scope of a leaked token to that user's data.
  2. The gateway's sync only creates Scentic time entries for Kimai timesheets whose `user` is a currently-active member of the Firm's team and whose `project`/`activity` are mapped to Scentic entities. Entries with unmapped projects/activities are dropped and logged as `kimai.sync.unmapped`.
  3. The gateway flags entries created directly in Kimai (not via the gateway) with a `kimai-origin: direct` marker in the webhook so Scentic can apply extra scrutiny (e.g. require user confirmation, or reject if Firm policy forbids direct Kimai entry).
  4. Anomaly detection: a spike in time entries from a single user or outside working hours triggers a security event.
  5. Direct Kimai access is blocked by network isolation (T-08).
- **Proposed tests:**
  - **Injection test:** Using a leaked user token, create a timesheet directly in Kimai for a mapped project. Assert the gateway sync emits a webhook with `kimai-origin: direct`. Assert Scentic applies the configured scrutiny (reject or flag).
  - **Unmapped-project test:** Create a timesheet directly in Kimai for an unmapped project. Assert the gateway drops it and logs `kimai.sync.unmapped`.
  - **Removed-user test:** Create a timesheet in Kimai as a user removed from the Firm. Assert the gateway drops it (user no longer on team).
  - **Anomaly test:** Create a burst of time entries outside working hours. Assert a security event is emitted.

## T-12 Overbroad service account (gateway Kimai/OpenSign credentials with too much access)

- **Severity:** HIGH
- **Description:** If the gateway uses a single Kimai admin token and a single OpenSign `MASTER_KEY` for all operations, a compromise of that credential gives full access to all Firms' data. This defeats Firm isolation.
- **Attack vector:**
  1. The gateway's Kimai admin token or OpenSign `MASTER_KEY` leaks.
  2. Attacker uses it to read/modify all Firms' data directly.
- **Impact:** Total compromise of all Firms' time/ signature data.
- **Proposed controls:**
  1. Routine operations use per-Firm / per-user tokens, not the admin/master credential.
  2. The Kimai admin token is used only for bootstrap (init-firm, user provisioning). The OpenSign `MASTER_KEY` is used only for tenant/user provisioning.
  3. Per-Firm tokens are scoped to the Firm's team/tenant.
  4. The admin/master credentials are stored in a secret manager (KMS/Vault), rotated on schedule, and accessed only at bootstrap.
  5. The gateway's runtime holds per-Firm/per-user tokens in memory (encrypted at rest); the master key is not held in runtime memory except during provisioning.
  6. Audit: every use of the admin/master credential is logged at a higher severity.
- **Proposed tests:**
  - **Least-privilege test:** Use a per-Firm token to attempt access to another Firm's data. Assert rejection.
  - **Master-key-use test:** Assert the master key is used only during provisioning calls (audit log review); no routine operation uses it.
  - **Rotation test:** Rotate the master key and a per-Firm token. Assert operations continue without interruption and old credentials fail.
  - **Memory-exposure test (code review):** Assert the master key is not held in long-lived runtime memory outside provisioning.

## T-13 Source-offer accidentally exposing proprietary code or secrets

- **Severity:** MEDIUM
- **Description:** The AGPL source offer (the public repo + `GET /source-offer` endpoint) could accidentally include Scentic proprietary code, secrets, or client data if repo boundaries are not enforced.
- **Attack vector:**
  1. A developer commits Scentic proprietary code or a `.env` file into the AGPL repo.
  2. Or the `vendor/kimai` or `vendor/opensign` clones accidentally include Scentic patches that contain proprietary logic.
  3. The public repo now exposes proprietary code or secrets.
- **Impact:** IP leak, secret leak, AGPL contamination of proprietary code (T-15).
- **Proposed controls:**
  1. Repo boundary: the AGPL repo contains only gateway code, docs, deploy configs, and upstream vendor clones. No `@scentic/*` packages, no proprietary logic.
  2. `.gitignore` excludes `.env*`, credentials, and Factory local settings.
  3. Pre-commit and CI secret scanning (gitleaks/trufflehog) on the AGPL repo.
  4. The `GET /source-offer` endpoint returns only public metadata (repo URL, license, upstream URLs, build instructions). No secrets, no Firm data.
  5. Vendor clones are shallow and unmodified; any patches are tracked as separate patch files reviewed for proprietary content.
  6. Periodic repo boundary review by the `security-auditor` droid.
- **Proposed tests:**
  - **Secret-scan test:** Run gitleaks/trufflehog on the AGPL repo. Assert no secrets detected.
  - **Repo-boundary test:** Assert no `@scentic/*` imports or proprietary file paths exist in the AGPL repo (automated grep).
  - **Source-offer test:** Fetch `GET /source-offer`. Assert the response contains no secrets, no Firm data, no proprietary code references beyond the public repo URL.
  - **Gitignore test:** Attempt to commit a `.env` file. Assert pre-commit hooks block it.

## T-14 Logs containing document contents/signers/matter names

- **Severity:** HIGH
- **Description:** Verbose logging in the gateway (or in Kimai/OpenSign) could log document contents, signer emails, matter names, time entry descriptions, or tokens, exposing them to anyone with log access.
- **Attack vector:**
  1. A gateway code path logs the full request/response body (including PDF content, signer emails, matter names).
  2. Or an error handler logs the upstream response verbatim.
  3. Logs are aggregated to a system with broad read access.
- **Impact:** Disclosure of confidential legal data via logs.
- **Proposed controls:**
  1. Structured logging with explicit fields; never `log(request.body)` or `log(response.body)`.
  2. Redaction: a logging middleware redacts known-sensitive fields (`description`, `contentBase64`, `email`, `name`, `title`, `apiToken`, `sessionToken`, `X-Scentic-Service-Token`, `X-Gateway-Signature`) by replacing with `[REDACTED]` or a hash.
  3. PDF content is never logged (even at debug level).
  4. Audit events log hashes of sensitive fields, not plaintext (see API_CONTRACTS.md §8).
  5. Log access is restricted and audited.
  6. A logging test suite asserts no sensitive fields appear in logs across all code paths.
- **Proposed tests:**
  - **Log-redaction test:** Run a full workflow (create, sign, complete, download) with debug logging on. Assert logs contain no `description`, no `contentBase64`, no signer `email`/`name`, no `title` in plaintext, no tokens.
  - **Error-log test:** Trigger upstream errors (Kimai/OpenSign unreachable). Assert error logs do not contain request bodies or tokens.
  - **Mutation test:** Remove the redaction middleware (mutation) and assert the log-redaction test fails.

## T-15 AGPL license contamination (AGPL code leaking into Scentic proprietary repo)

- **Severity:** HIGH
- **Description:** If AGPL-licensed code from the gateway, Kimai, or OpenSign is copied into the proprietary Scentic core repo, the AGPL obligations could extend to Scentic's proprietary code, forcing it to be open-sourced.
- **Attack vector:**
  1. A developer copies a utility function or type from the AGPL gateway into Scentic core.
  2. Or a dependency from `vendor/kimai` or `vendor/opensign` is imported directly into Scentic core.
  3. The AGPL license now applies to the incorporated code.
- **Impact:** License contamination; potential obligation to open-source proprietary Scentic code.
- **Proposed controls:**
  1. Repo isolation: AGPL code lives only in the AGPL repo. Scentic core communicates via REST/webhook only; no source-level imports.
  2. Scentic core's `package.json`/lockfiles must not include the AGPL repo or its packages.
  3. Import scanning in Scentic core CI: assert no imports from `scentic-agpl-services`, `kimai`, `opensign`, or AGPL-licensed packages.
  4. License headers in the AGPL repo make provenance obvious.
  5. Developer guidelines explicitly prohibit copy/paste from the AGPL repo into Scentic core.
  6. The `integration-contract-validator` droid verifies the boundary at each phase.
- **Proposed tests:**
  - **Import-scan test (Scentic core CI):** Scan Scentic core for imports of AGPL packages or paths. Assert none.
  - **License-scan test (Scentic core CI):** Scan Scentic core dependencies for AGPL licenses. Assert none (or explicit allowlist with legal sign-off).
  - **Boundary test:** Attempt to import a gateway utility into Scentic core (simulated). Assert CI fails.

## T-16 OpenSign MASTER_KEY compromise (full data access)

- **Severity:** CRITICAL
- **Description:** The OpenSign `MASTER_KEY` (configured via `OPENSIGN_MASTER_KEY`) grants full access to the OpenSign instance. If compromised, an attacker can read/modify/delete all documents across all Firms.
- **Attack vector:**
  1. `OPENSIGN_MASTER_KEY` leaks (config file, env var in logs, secret manager misconfiguration, overuse in runtime).
  2. Attacker uses the key to access OpenSign directly, bypassing all tenant/ACL boundaries.
- **Impact:** Total compromise of all signature workflows and signed documents across all Firms.
- **Proposed controls:**
  1. The master key is used **only** for provisioning (tenant/user creation) during `init-firm` and user lifecycle events. Routine document operations use per-Firm/per-user session tokens.
  2. The master key is stored in a secret manager (KMS/Vault), never in plaintext config, never in `.env.example` (only a placeholder), never logged.
  3. The master key is rotated on schedule and on incident; rotation re-provisions per-Firm tokens without downtime.
  4. The master key is not held in long-lived runtime memory outside provisioning calls.
  5. OpenSign is network-isolated (T-08) so a leaked key cannot be used from outside the gateway network.
  6. Audit: every use of the master key is logged at CRITICAL severity and alerted.
  7. OpenSign deployment hardening: the master key is not exposed via any OpenSign API endpoint.
- **Proposed tests:**
  - **Master-key-use test:** Assert the master key is used only during provisioning (audit log review across a full workflow lifecycle); no document operation uses it.
  - **Rotation test:** Rotate the master key. Assert provisioning continues and document operations continue (using per-Firm tokens) without interruption.
  - **Leak-detection test:** Simulate the master key appearing in a log (gitleaks custom rule). Assert CI fails.
  - **Network-isolation test:** Attempt to use the master key from a non-gateway host. Assert network-level rejection (T-08).
  - **Privilege test:** Use a per-Firm session token to attempt an operation reserved for the master key (e.g. tenant creation). Assert rejection.

> **AGPL-02 mitigation note:** T-16 is partially mitigated in AGPL-02 by **using the master key only for provisioning-style operations** (admin login, tenant creation, user creation). The OpenSign client (`gateway/src/opensign/opensign-client.ts`) authenticates with the master key for all current operations, which is a carried gap: the production target is to use per-user/per-firm session tokens for routine document operations and restrict the master key to tenant/user provisioning only (see `docs/AGPL_02_CLOSEOUT.md` §5). The master key is never logged, never sent to Scentic, and is subject to the production config validation in `gateway/src/config.ts` (must be a strong non-placeholder value when `OPENSIGN_ENABLED=true`). Network isolation (T-08) prevents the master key from being used from outside the gateway network. Full T-16 closure (master key used **only** for provisioning, routine ops on per-firm tokens) is an AGPL-04 production-readiness requirement.

---

## Appendix A: Severity definitions

| Severity | Definition |
|----------|------------|
| CRITICAL | Leads to forged legal artifacts, total data compromise, or catastrophic integrity loss. Must be fixed before any production deployment. |
| HIGH | Leads to cross-Firm data leakage, unauthorized access, or persistent post-offboard access. Must be fixed before phase gate closure. |
| MEDIUM | Leads to limited disclosure or usability issues with confidentiality implications. Must be fixed before release; may be tracked as a hardening item during phased development. |
| LOW | Minor issues; fix opportunistically. |

## Appendix B: Mapping to Scentic testing disciplines

| Threat | Primary test discipline |
|--------|-------------------------|
| T-01, T-02 | Cross-firm and cross-client leakage tests; negative authorization tests |
| T-03, T-04 | Webhook contract tests; replay/negative tests |
| T-05, T-06, T-07 | Lifecycle/lease tests; reconciliation tests |
| T-08, T-12 | Security scanning; network isolation verification |
| T-09 | Integration tests with email capture (staging) |
| T-10 | Document lifecycle integration tests; signature verification tests |
| T-11 | Time-entry injection tests; anomaly detection tests |
| T-13, T-15 | Dependency and secret scanning; license scanning; repo boundary tests |
| T-14 | Log redaction property tests |
| T-16 | Credential rotation tests; privilege tests |

## Appendix C: Open questions (AGPL-00)

- Exact OpenSign signature-verification library to use for PDF integrity checks (T-10).
- Whether the reconciliation job (T-05/T-06) pulls from a Scentic endpoint or a snapshot — depends on Scentic core's admin API surface.
- Whether email notifications (T-09) are disabled by default in production or required for signer experience.
- Anomaly detection thresholds for T-11 (burst size, off-hours window).
- Master key rotation cadence (T-16) — proposed 90 days, to confirm with security policy.
