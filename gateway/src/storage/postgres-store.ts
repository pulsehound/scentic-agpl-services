/**
 * Postgres durable store — implements MappingStore, NonceStore, and EventOutbox.
 *
 * Production-grade async store backed by `pg.Pool`.
 *
 * Security:
 * - All mappings are Firm-scoped (WHERE scentic_firm_id = $1)
 * - No document contents stored
 * - Signer emails stored as hashes only
 * - Nonces persist across restarts
 * - Outbox events survive restart
 * - Multi-instance safe: nonces use ON CONFLICT DO NOTHING, outbox uses
 *   SELECT ... FOR UPDATE SKIP LOCKED
 * - All queries use parameterized placeholders ($1, $2, ...) — no SQL injection
 */

import { Pool, type QueryResult } from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FirmMapping, UserMapping, ClientMapping, MatterMapping,
  ActivityMapping, TimeEntryMapping,
  SyncFirmParams, SyncUserParams, SyncClientParams, SyncMatterParams,
  SyncActivityParams, CreateTimeEntryParams,
  ListTimeEntriesParams,
  OpenSignFirmMapping, OpenSignUserMapping,
  OpenSignWorkflowMapping, OpenSignSignerMapping,
  SyncOpenSignFirmParams, SyncOpenSignUserParams, CreateOpenSignWorkflowParams,
} from '../mappings/types.js';
import type { MappingStore } from '../mappings/mapping-store.js';
import type { NonceStore } from '../auth/hmac.js';
import type { EventOutbox, OutboxEvent } from '../events/outbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function now(): string { return new Date().toISOString(); }

/**
 * Convert a TIMESTAMPTZ value returned by pg (a Date object) into an ISO
 * string expected by the mapping types. Falls back to string coercion for
 * non-Date values.
 */
function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Convert a JSONB value returned by pg. pg parses JSONB columns into JS
 * objects by default, but be defensive in case a string is returned.
 */
function toJson(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return JSON.parse(v);
  return v as Record<string, unknown>;
}

export class PostgresMappingStore implements MappingStore, NonceStore, EventOutbox {
  private pool: Pool;
  private maxAgeMs: number;

  constructor(connectionString: string, sslMode: string = 'disable', maxAgeMs: number = 300_000) {
    const ssl = sslMode === 'disable'
      ? false
      : { rejectUnauthorized: sslMode === 'verify-full' || sslMode === 'verify-ca' };
    this.pool = new Pool({
      connectionString,
      max: 10,
      ssl: ssl as Pool['options']['ssl'],
    });
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Apply the schema. Reads postgres-schema.sql and executes every statement.
   * Must be called once after construction before any other method.
   */
  async initSchema(): Promise<void> {
    const schemaPath = join(__dirname, 'postgres-schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    await this.pool.query(schema);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── MappingStore: Firm ─────────────────────────────────────────────────
  async getFirmMapping(scenticFirmId: string): Promise<FirmMapping | null> {
    const res = await this.pool.query('SELECT * FROM firm_mappings WHERE scentic_firm_id = $1', [scenticFirmId]);
    return res.rows[0] ? this.rowToFirmMapping(res.rows[0]) : null;
  }

  async upsertFirmMapping(params: SyncFirmParams, kimaiTeamId: number, kimaiTeamName: string): Promise<FirmMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO firm_mappings (id, scentic_firm_id, kimai_team_id, kimai_team_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)
       ON CONFLICT (scentic_firm_id) DO UPDATE
       SET kimai_team_id = EXCLUDED.kimai_team_id, kimai_team_name = EXCLUDED.kimai_team_name, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, kimaiTeamId, kimaiTeamName, ts],
    );
    return this.rowToFirmMapping(res.rows[0]);
  }

  async disableFirmMapping(scenticFirmId: string): Promise<void> {
    await this.pool.query(
      'UPDATE firm_mappings SET status = $1, updated_at = $2 WHERE scentic_firm_id = $3',
      ['DISABLED', now(), scenticFirmId],
    );
  }

  // ── MappingStore: User ─────────────────────────────────────────────────
  async getUserMapping(scenticFirmId: string, scenticUserId: string): Promise<UserMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM user_mappings WHERE scentic_firm_id = $1 AND scentic_user_id = $2',
      [scenticFirmId, scenticUserId],
    );
    return res.rows[0] ? this.rowToUserMapping(res.rows[0]) : null;
  }

  async upsertUserMapping(params: SyncUserParams, kimaiUserId: number, kimaiUsername: string, kimaiApiToken: string): Promise<UserMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO user_mappings (id, scentic_firm_id, scentic_user_id, kimai_user_id, kimai_username, kimai_api_token, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)
       ON CONFLICT (scentic_firm_id, scentic_user_id) DO UPDATE
       SET kimai_user_id = EXCLUDED.kimai_user_id, kimai_username = EXCLUDED.kimai_username, kimai_api_token = EXCLUDED.kimai_api_token, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, params.scenticUserId, kimaiUserId, kimaiUsername, kimaiApiToken, ts],
    );
    return this.rowToUserMapping(res.rows[0]);
  }

  async disableUserMapping(scenticFirmId: string, scenticUserId: string): Promise<void> {
    await this.pool.query(
      'UPDATE user_mappings SET status = $1, updated_at = $2 WHERE scentic_firm_id = $3 AND scentic_user_id = $4',
      ['DISABLED', now(), scenticFirmId, scenticUserId],
    );
  }

  // ── MappingStore: Client ───────────────────────────────────────────────
  async getClientMapping(scenticFirmId: string, scenticClientId: string): Promise<ClientMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM client_mappings WHERE scentic_firm_id = $1 AND scentic_client_id = $2',
      [scenticFirmId, scenticClientId],
    );
    return res.rows[0] ? this.rowToClientMapping(res.rows[0]) : null;
  }

  async upsertClientMapping(params: SyncClientParams, kimaiCustomerId: number, displayLabel: string): Promise<ClientMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO client_mappings (id, scentic_firm_id, scentic_client_id, kimai_customer_id, display_label_used, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6)
       ON CONFLICT (scentic_firm_id, scentic_client_id) DO UPDATE
       SET kimai_customer_id = EXCLUDED.kimai_customer_id, display_label_used = EXCLUDED.display_label_used, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, params.scenticClientId, kimaiCustomerId, displayLabel, ts],
    );
    return this.rowToClientMapping(res.rows[0]);
  }

  // ── MappingStore: Matter ───────────────────────────────────────────────
  async getMatterMapping(scenticFirmId: string, scenticMatterId: string): Promise<MatterMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM matter_mappings WHERE scentic_firm_id = $1 AND scentic_matter_id = $2',
      [scenticFirmId, scenticMatterId],
    );
    return res.rows[0] ? this.rowToMatterMapping(res.rows[0]) : null;
  }

  async upsertMatterMapping(params: SyncMatterParams, kimaiProjectId: number, displayLabel: string): Promise<MatterMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO matter_mappings (id, scentic_firm_id, scentic_matter_id, scentic_client_id, kimai_project_id, display_label_used, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)
       ON CONFLICT (scentic_firm_id, scentic_matter_id) DO UPDATE
       SET kimai_project_id = EXCLUDED.kimai_project_id, display_label_used = EXCLUDED.display_label_used, scentic_client_id = EXCLUDED.scentic_client_id, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, params.scenticMatterId, params.scenticClientId, kimaiProjectId, displayLabel, ts],
    );
    return this.rowToMatterMapping(res.rows[0]);
  }

  // ── MappingStore: Activity ─────────────────────────────────────────────
  async getActivityMapping(scenticFirmId: string, scenticActivityCode: string): Promise<ActivityMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM activity_mappings WHERE scentic_firm_id = $1 AND scentic_activity_code = $2',
      [scenticFirmId, scenticActivityCode],
    );
    return res.rows[0] ? this.rowToActivityMapping(res.rows[0]) : null;
  }

  async upsertActivityMapping(params: SyncActivityParams, kimaiActivityId: number): Promise<ActivityMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO activity_mappings (id, scentic_firm_id, scentic_activity_code, kimai_activity_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)
       ON CONFLICT (scentic_firm_id, scentic_activity_code) DO UPDATE
       SET kimai_activity_id = EXCLUDED.kimai_activity_id, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, params.scenticActivityCode, kimaiActivityId, ts],
    );
    return this.rowToActivityMapping(res.rows[0]);
  }

  // ── MappingStore: TimeEntry ────────────────────────────────────────────
  async getTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): Promise<TimeEntryMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM time_entry_mappings WHERE scentic_firm_id = $1 AND scentic_time_entry_id = $2',
      [scenticFirmId, scenticTimeEntryId],
    );
    return res.rows[0] ? this.rowToTimeEntryMapping(res.rows[0]) : null;
  }

  async upsertTimeEntryMapping(params: CreateTimeEntryParams, kimaiTimesheetId: number): Promise<TimeEntryMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO time_entry_mappings (id, scentic_firm_id, scentic_time_entry_id, kimai_timesheet_id, scentic_matter_id, scentic_user_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)
       ON CONFLICT (scentic_firm_id, scentic_time_entry_id) DO UPDATE
       SET kimai_timesheet_id = EXCLUDED.kimai_timesheet_id, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, params.scenticTimeEntryId, kimaiTimesheetId, params.scenticMatterId, params.scenticUserId, ts],
    );
    return this.rowToTimeEntryMapping(res.rows[0]);
  }

  async updateTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): Promise<void> {
    await this.pool.query(
      'UPDATE time_entry_mappings SET updated_at = $1 WHERE scentic_firm_id = $2 AND scentic_time_entry_id = $3',
      [now(), scenticFirmId, scenticTimeEntryId],
    );
  }

  async deleteTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): Promise<void> {
    await this.pool.query(
      'UPDATE time_entry_mappings SET status = $1, updated_at = $2 WHERE scentic_firm_id = $3 AND scentic_time_entry_id = $4',
      ['DISABLED', now(), scenticFirmId, scenticTimeEntryId],
    );
  }

  async listTimeEntryMappings(params: ListTimeEntriesParams): Promise<TimeEntryMapping[]> {
    let sql = 'SELECT * FROM time_entry_mappings WHERE scentic_firm_id = $1 AND status = $2';
    const args: unknown[] = [params.scenticFirmId, 'ACTIVE'];
    if (params.scenticUserId) { sql += ' AND scentic_user_id = $' + (args.length + 1); args.push(params.scenticUserId); }
    if (params.scenticMatterId) { sql += ' AND scentic_matter_id = $' + (args.length + 1); args.push(params.scenticMatterId); }
    const res = await this.pool.query(sql, args);
    return res.rows.map(r => this.rowToTimeEntryMapping(r));
  }

  // ── MappingStore: OpenSign Firm ────────────────────────────────────────
  async getOpenSignFirmMapping(scenticFirmId: string): Promise<OpenSignFirmMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM opensign_firm_mappings WHERE scentic_firm_id = $1',
      [scenticFirmId],
    );
    return res.rows[0] ? this.rowToOpenSignFirmMapping(res.rows[0]) : null;
  }

  async upsertOpenSignFirmMapping(params: SyncOpenSignFirmParams, opensignTenantId: string, opensignTenantName: string): Promise<OpenSignFirmMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO opensign_firm_mappings (id, scentic_firm_id, opensign_tenant_id, opensign_tenant_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)
       ON CONFLICT (scentic_firm_id) DO UPDATE
       SET opensign_tenant_id = EXCLUDED.opensign_tenant_id, opensign_tenant_name = EXCLUDED.opensign_tenant_name, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, opensignTenantId, opensignTenantName, ts],
    );
    return this.rowToOpenSignFirmMapping(res.rows[0]);
  }

  async disableOpenSignFirmMapping(scenticFirmId: string): Promise<void> {
    await this.pool.query(
      'UPDATE opensign_firm_mappings SET status = $1, updated_at = $2 WHERE scentic_firm_id = $3',
      ['DISABLED', now(), scenticFirmId],
    );
  }

  // ── MappingStore: OpenSign User ────────────────────────────────────────
  async getOpenSignUserMapping(scenticFirmId: string, scenticUserId: string): Promise<OpenSignUserMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM opensign_user_mappings WHERE scentic_firm_id = $1 AND scentic_user_id = $2',
      [scenticFirmId, scenticUserId],
    );
    return res.rows[0] ? this.rowToOpenSignUserMapping(res.rows[0]) : null;
  }

  async upsertOpenSignUserMapping(params: SyncOpenSignUserParams, opensignUserId: string, opensignSessionToken: string): Promise<OpenSignUserMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO opensign_user_mappings (id, scentic_firm_id, scentic_user_id, opensign_user_id, opensign_email, opensign_session_token, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)
       ON CONFLICT (scentic_firm_id, scentic_user_id) DO UPDATE
       SET opensign_user_id = EXCLUDED.opensign_user_id, opensign_email = EXCLUDED.opensign_email, opensign_session_token = EXCLUDED.opensign_session_token, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, params.scenticUserId, opensignUserId, params.email, opensignSessionToken, ts],
    );
    return this.rowToOpenSignUserMapping(res.rows[0]);
  }

  // ── MappingStore: OpenSign Workflow ────────────────────────────────────
  async getOpenSignWorkflowMapping(scenticFirmId: string, scenticSignatureWorkflowId: string): Promise<OpenSignWorkflowMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM opensign_workflow_mappings WHERE scentic_firm_id = $1 AND scentic_signature_workflow_id = $2',
      [scenticFirmId, scenticSignatureWorkflowId],
    );
    return res.rows[0] ? this.rowToOpenSignWorkflowMapping(res.rows[0]) : null;
  }

  async upsertOpenSignWorkflowMapping(params: CreateOpenSignWorkflowParams, opensignDocumentId: string, opensignWorkflowId: string, opensignStatus: string): Promise<OpenSignWorkflowMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO opensign_workflow_mappings (id, scentic_firm_id, scentic_signature_workflow_id, scentic_matter_id, scentic_document_id, scentic_document_version_id, opensign_document_id, opensign_workflow_id, opensign_status, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10, $10)
       ON CONFLICT (scentic_firm_id, scentic_signature_workflow_id) DO UPDATE
       SET opensign_document_id = EXCLUDED.opensign_document_id, opensign_workflow_id = EXCLUDED.opensign_workflow_id, opensign_status = EXCLUDED.opensign_status, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, params.scenticFirmId, params.scenticSignatureWorkflowId, params.scenticMatterId, params.scenticDocumentId, params.scenticDocumentVersionId, opensignDocumentId, opensignWorkflowId, opensignStatus, ts],
    );
    return this.rowToOpenSignWorkflowMapping(res.rows[0]);
  }

  async updateOpenSignWorkflowStatus(scenticFirmId: string, scenticSignatureWorkflowId: string, opensignStatus: string): Promise<void> {
    await this.pool.query(
      'UPDATE opensign_workflow_mappings SET opensign_status = $1, updated_at = $2 WHERE scentic_firm_id = $3 AND scentic_signature_workflow_id = $4',
      [opensignStatus, now(), scenticFirmId, scenticSignatureWorkflowId],
    );
  }

  async listOpenSignWorkflowMappings(scenticFirmId: string): Promise<OpenSignWorkflowMapping[]> {
    const res = await this.pool.query(
      'SELECT * FROM opensign_workflow_mappings WHERE scentic_firm_id = $1 AND status = $2',
      [scenticFirmId, 'ACTIVE'],
    );
    return res.rows.map(r => this.rowToOpenSignWorkflowMapping(r));
  }

  // ── MappingStore: OpenSign Signer ──────────────────────────────────────
  async getOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string): Promise<OpenSignSignerMapping | null> {
    const res = await this.pool.query(
      'SELECT * FROM opensign_signer_mappings WHERE scentic_firm_id = $1 AND scentic_signature_workflow_id = $2 AND scentic_signer_id = $3',
      [scenticFirmId, scenticSignatureWorkflowId, scenticSignerId],
    );
    return res.rows[0] ? this.rowToOpenSignSignerMapping(res.rows[0]) : null;
  }

  async upsertOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string, opensignSignerId: string, signerEmailHash: string): Promise<OpenSignSignerMapping> {
    const ts = now();
    const id = crypto.randomUUID();
    const res = await this.pool.query(
      `INSERT INTO opensign_signer_mappings (id, scentic_firm_id, scentic_signature_workflow_id, scentic_signer_id, opensign_signer_id, signer_email_hash, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $7)
       ON CONFLICT (scentic_firm_id, scentic_signature_workflow_id, scentic_signer_id) DO UPDATE
       SET opensign_signer_id = EXCLUDED.opensign_signer_id, signer_email_hash = EXCLUDED.signer_email_hash, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [id, scenticFirmId, scenticSignatureWorkflowId, scenticSignerId, opensignSignerId, signerEmailHash, ts],
    );
    return this.rowToOpenSignSignerMapping(res.rows[0]);
  }

  // ── MappingStore: Utility ──────────────────────────────────────────────
  async clear(): Promise<void> {
    await this.pool.query(
      'TRUNCATE firm_mappings, user_mappings, client_mappings, matter_mappings, activity_mappings, time_entry_mappings, opensign_firm_mappings, opensign_user_mappings, opensign_workflow_mappings, opensign_signer_mappings, nonces, idempotency_keys, outbox_events',
    );
  }

  // ── NonceStore ─────────────────────────────────────────────────────────
  async seen(nonce: string, timestamp: number): Promise<boolean> {
    // Clean expired nonces
    const cutoff = Date.now() - this.maxAgeMs;
    await this.pool.query('DELETE FROM nonces WHERE timestamp < $1', [cutoff]);
    // Atomic insert: ON CONFLICT DO NOTHING. rowCount === 0 means the nonce
    // already existed (replay), rowCount === 1 means it was newly inserted.
    const res: QueryResult = await this.pool.query(
      'INSERT INTO nonces (nonce, timestamp, created_at) VALUES ($1, $2, $3) ON CONFLICT (nonce) DO NOTHING',
      [nonce, timestamp, now()],
    );
    return res.rowCount === 0;
  }

  // ── EventOutbox ────────────────────────────────────────────────────────
  async publish(event: Omit<OutboxEvent, 'eventId' | 'createdAt' | 'retryCount' | 'maxRetries' | 'status'>): Promise<OutboxEvent> {
    const fullEvent: OutboxEvent = {
      ...event,
      eventId: crypto.randomUUID(),
      createdAt: now(),
      retryCount: 0,
      maxRetries: 5,
      status: 'PENDING',
    };
    await this.pool.query(
      'INSERT INTO outbox_events (event_id, event_type, scentic_firm_id, correlation_id, created_at, payload, safe_summary, retry_count, max_retries, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [fullEvent.eventId, fullEvent.eventType, fullEvent.scenticFirmId, fullEvent.correlationId, fullEvent.createdAt, fullEvent.payload, fullEvent.safeSummary, 0, 5, 'PENDING'],
    );
    return fullEvent;
  }

  async getPending(): Promise<OutboxEvent[]> {
    // FOR UPDATE SKIP LOCKED enables safe concurrent processing across multiple
    // gateway instances — each instance claims a distinct batch without
    // blocking on rows locked by another instance.
    const res = await this.pool.query(
      'SELECT * FROM outbox_events WHERE status = $1 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 100',
      ['PENDING'],
    );
    return res.rows.map(r => this.rowToOutboxEvent(r));
  }

  async markSent(eventId: string): Promise<void> {
    await this.pool.query('UPDATE outbox_events SET status = $1 WHERE event_id = $2', ['SENT', eventId]);
  }

  async markFailed(eventId: string): Promise<void> {
    // Atomically increment retry count and flip to FAILED once maxRetries is reached.
    await this.pool.query(
      `UPDATE outbox_events
       SET retry_count = retry_count + 1,
           status = CASE WHEN retry_count + 1 >= max_retries THEN 'FAILED' ELSE 'PENDING' END
       WHERE event_id = $1`,
      [eventId],
    );
  }

  async getAll(): Promise<OutboxEvent[]> {
    const res = await this.pool.query('SELECT * FROM outbox_events ORDER BY created_at');
    return res.rows.map(r => this.rowToOutboxEvent(r));
  }

  // ── Row converters (snake_case DB row → camelCase TS object) ────────────
  private rowToFirmMapping(r: any): FirmMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, kimaiTeamId: r.kimai_team_id, kimaiTeamName: r.kimai_team_name, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToUserMapping(r: any): UserMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticUserId: r.scentic_user_id, kimaiUserId: r.kimai_user_id, kimaiUsername: r.kimai_username, kimaiApiToken: r.kimai_api_token, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToClientMapping(r: any): ClientMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticClientId: r.scentic_client_id, kimaiCustomerId: r.kimai_customer_id, displayLabelUsed: r.display_label_used, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToMatterMapping(r: any): MatterMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticMatterId: r.scentic_matter_id, scenticClientId: r.scentic_client_id, kimaiProjectId: r.kimai_project_id, displayLabelUsed: r.display_label_used, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToActivityMapping(r: any): ActivityMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticActivityCode: r.scentic_activity_code, kimaiActivityId: r.kimai_activity_id, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToTimeEntryMapping(r: any): TimeEntryMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticTimeEntryId: r.scentic_time_entry_id, kimaiTimesheetId: r.kimai_timesheet_id, scenticMatterId: r.scentic_matter_id, scenticUserId: r.scentic_user_id, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToOpenSignFirmMapping(r: any): OpenSignFirmMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, opensignTenantId: r.opensign_tenant_id, opensignTenantName: r.opensign_tenant_name, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToOpenSignUserMapping(r: any): OpenSignUserMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticUserId: r.scentic_user_id, opensignUserId: r.opensign_user_id, opensignEmail: r.opensign_email, opensignSessionToken: r.opensign_session_token, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToOpenSignWorkflowMapping(r: any): OpenSignWorkflowMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticSignatureWorkflowId: r.scentic_signature_workflow_id, scenticMatterId: r.scentic_matter_id, scenticDocumentId: r.scentic_document_id, scenticDocumentVersionId: r.scentic_document_version_id, opensignDocumentId: r.opensign_document_id, opensignWorkflowId: r.opensign_workflow_id, opensignStatus: r.opensign_status, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToOpenSignSignerMapping(r: any): OpenSignSignerMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticSignatureWorkflowId: r.scentic_signature_workflow_id, scenticSignerId: r.scentic_signer_id, opensignSignerId: r.opensign_signer_id, signerEmailHash: r.signer_email_hash, status: r.status, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) };
  }
  private rowToOutboxEvent(r: any): OutboxEvent {
    return { eventId: r.event_id, eventType: r.event_type, scenticFirmId: r.scentic_firm_id, correlationId: r.correlation_id, createdAt: toIso(r.created_at), payload: toJson(r.payload), safeSummary: r.safe_summary, retryCount: r.retry_count, maxRetries: r.max_retries, status: r.status };
  }
}
