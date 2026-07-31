/**
 * SQLite durable store — implements MappingStore, NonceStore, and EventOutbox.
 *
 * Security:
 * - All mappings are Firm-scoped (WHERE scentic_firm_id = ?)
 * - No document contents stored
 * - Signer emails stored as hashes only
 * - Nonces persist across restarts
 * - Outbox events survive restart
 * - Production should use Postgres, not SQLite
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FirmMapping, UserMapping, ClientMapping, MatterMapping,
  ActivityMapping, TimeEntryMapping, MappingStatus,
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

export class SqliteMappingStore implements MappingStore, NonceStore, EventOutbox {
  private db: Database.Database;
  private maxAgeMs: number;

  constructor(dbPath: string, maxAgeMs: number = 300_000) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.maxAgeMs = maxAgeMs;
    this.initSchema();
  }

  private initSchema(): void {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  close(): void {
    this.db.close();
  }

  // ── MappingStore: Firm ─────────────────────────────────────────────────
  async getFirmMapping(scenticFirmId: string): Promise<FirmMapping | null> {
    const row = this.db.prepare('SELECT * FROM firm_mappings WHERE scentic_firm_id = ?').get(scenticFirmId) as any;
    return row ? this.rowToFirmMapping(row) : null;
  }

  async upsertFirmMapping(params: SyncFirmParams, kimaiTeamId: number, kimaiTeamName: string): Promise<FirmMapping> {
    const existing = await this.getFirmMapping(params.scenticFirmId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE firm_mappings SET kimai_team_id = ?, kimai_team_name = ?, updated_at = ? WHERE scentic_firm_id = ?')
        .run(kimaiTeamId, kimaiTeamName, ts, params.scenticFirmId);
      return { ...existing, kimaiTeamId, kimaiTeamName, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO firm_mappings (id, scentic_firm_id, kimai_team_id, kimai_team_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, kimaiTeamId, kimaiTeamName, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, kimaiTeamId, kimaiTeamName, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  async disableFirmMapping(scenticFirmId: string): Promise<void> {
    this.db.prepare('UPDATE firm_mappings SET status = ?, updated_at = ? WHERE scentic_firm_id = ?')
      .run('DISABLED', now(), scenticFirmId);
  }

  // ── MappingStore: User ─────────────────────────────────────────────────
  async getUserMapping(scenticFirmId: string, scenticUserId: string): Promise<UserMapping | null> {
    const row = this.db.prepare('SELECT * FROM user_mappings WHERE scentic_firm_id = ? AND scentic_user_id = ?').get(scenticFirmId, scenticUserId) as any;
    return row ? this.rowToUserMapping(row) : null;
  }

  async upsertUserMapping(params: SyncUserParams, kimaiUserId: number, kimaiUsername: string, kimaiApiToken: string): Promise<UserMapping> {
    const existing = await this.getUserMapping(params.scenticFirmId, params.scenticUserId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE user_mappings SET kimai_user_id = ?, kimai_username = ?, kimai_api_token = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_user_id = ?')
        .run(kimaiUserId, kimaiUsername, kimaiApiToken, ts, params.scenticFirmId, params.scenticUserId);
      return { ...existing, kimaiUserId, kimaiUsername, kimaiApiToken, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO user_mappings (id, scentic_firm_id, scentic_user_id, kimai_user_id, kimai_username, kimai_api_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, params.scenticUserId, kimaiUserId, kimaiUsername, kimaiApiToken, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, scenticUserId: params.scenticUserId, kimaiUserId, kimaiUsername, kimaiApiToken, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  async disableUserMapping(scenticFirmId: string, scenticUserId: string): Promise<void> {
    this.db.prepare('UPDATE user_mappings SET status = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_user_id = ?')
      .run('DISABLED', now(), scenticFirmId, scenticUserId);
  }

  // ── MappingStore: Client ───────────────────────────────────────────────
  async getClientMapping(scenticFirmId: string, scenticClientId: string): Promise<ClientMapping | null> {
    const row = this.db.prepare('SELECT * FROM client_mappings WHERE scentic_firm_id = ? AND scentic_client_id = ?').get(scenticFirmId, scenticClientId) as any;
    return row ? this.rowToClientMapping(row) : null;
  }

  async upsertClientMapping(params: SyncClientParams, kimaiCustomerId: number, displayLabel: string): Promise<ClientMapping> {
    const existing = await this.getClientMapping(params.scenticFirmId, params.scenticClientId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE client_mappings SET kimai_customer_id = ?, display_label_used = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_client_id = ?')
        .run(kimaiCustomerId, displayLabel, ts, params.scenticFirmId, params.scenticClientId);
      return { ...existing, kimaiCustomerId, displayLabelUsed: displayLabel, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO client_mappings (id, scentic_firm_id, scentic_client_id, kimai_customer_id, display_label_used, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, params.scenticClientId, kimaiCustomerId, displayLabel, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, scenticClientId: params.scenticClientId, kimaiCustomerId, displayLabelUsed: displayLabel, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  // ── MappingStore: Matter ───────────────────────────────────────────────
  async getMatterMapping(scenticFirmId: string, scenticMatterId: string): Promise<MatterMapping | null> {
    const row = this.db.prepare('SELECT * FROM matter_mappings WHERE scentic_firm_id = ? AND scentic_matter_id = ?').get(scenticFirmId, scenticMatterId) as any;
    return row ? this.rowToMatterMapping(row) : null;
  }

  async upsertMatterMapping(params: SyncMatterParams, kimaiProjectId: number, displayLabel: string): Promise<MatterMapping> {
    const existing = await this.getMatterMapping(params.scenticFirmId, params.scenticMatterId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE matter_mappings SET kimai_project_id = ?, display_label_used = ?, scentic_client_id = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_matter_id = ?')
        .run(kimaiProjectId, displayLabel, params.scenticClientId, ts, params.scenticFirmId, params.scenticMatterId);
      return { ...existing, kimaiProjectId, displayLabelUsed: displayLabel, scenticClientId: params.scenticClientId, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO matter_mappings (id, scentic_firm_id, scentic_matter_id, scentic_client_id, kimai_project_id, display_label_used, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, params.scenticMatterId, params.scenticClientId, kimaiProjectId, displayLabel, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, scenticMatterId: params.scenticMatterId, scenticClientId: params.scenticClientId, kimaiProjectId, displayLabelUsed: displayLabel, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  // ── MappingStore: Activity ─────────────────────────────────────────────
  async getActivityMapping(scenticFirmId: string, scenticActivityCode: string): Promise<ActivityMapping | null> {
    const row = this.db.prepare('SELECT * FROM activity_mappings WHERE scentic_firm_id = ? AND scentic_activity_code = ?').get(scenticFirmId, scenticActivityCode) as any;
    return row ? this.rowToActivityMapping(row) : null;
  }

  async upsertActivityMapping(params: SyncActivityParams, kimaiActivityId: number): Promise<ActivityMapping> {
    const existing = await this.getActivityMapping(params.scenticFirmId, params.scenticActivityCode);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE activity_mappings SET kimai_activity_id = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_activity_code = ?')
        .run(kimaiActivityId, ts, params.scenticFirmId, params.scenticActivityCode);
      return { ...existing, kimaiActivityId, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO activity_mappings (id, scentic_firm_id, scentic_activity_code, kimai_activity_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, params.scenticActivityCode, kimaiActivityId, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, scenticActivityCode: params.scenticActivityCode, kimaiActivityId, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  // ── MappingStore: TimeEntry ────────────────────────────────────────────
  async getTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): Promise<TimeEntryMapping | null> {
    const row = this.db.prepare('SELECT * FROM time_entry_mappings WHERE scentic_firm_id = ? AND scentic_time_entry_id = ?').get(scenticFirmId, scenticTimeEntryId) as any;
    return row ? this.rowToTimeEntryMapping(row) : null;
  }

  async upsertTimeEntryMapping(params: CreateTimeEntryParams, kimaiTimesheetId: number): Promise<TimeEntryMapping> {
    const existing = await this.getTimeEntryMapping(params.scenticFirmId, params.scenticTimeEntryId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE time_entry_mappings SET kimai_timesheet_id = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_time_entry_id = ?')
        .run(kimaiTimesheetId, ts, params.scenticFirmId, params.scenticTimeEntryId);
      return { ...existing, kimaiTimesheetId, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO time_entry_mappings (id, scentic_firm_id, scentic_time_entry_id, kimai_timesheet_id, scentic_matter_id, scentic_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, params.scenticTimeEntryId, kimaiTimesheetId, params.scenticMatterId, params.scenticUserId, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, scenticTimeEntryId: params.scenticTimeEntryId, kimaiTimesheetId, scenticMatterId: params.scenticMatterId, scenticUserId: params.scenticUserId, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  async updateTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): Promise<void> {
    this.db.prepare('UPDATE time_entry_mappings SET updated_at = ? WHERE scentic_firm_id = ? AND scentic_time_entry_id = ?')
      .run(now(), scenticFirmId, scenticTimeEntryId);
  }

  async deleteTimeEntryMapping(scenticFirmId: string, scenticTimeEntryId: string): Promise<void> {
    this.db.prepare('UPDATE time_entry_mappings SET status = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_time_entry_id = ?')
      .run('DISABLED', now(), scenticFirmId, scenticTimeEntryId);
  }

  async listTimeEntryMappings(params: ListTimeEntriesParams): Promise<TimeEntryMapping[]> {
    let sql = 'SELECT * FROM time_entry_mappings WHERE scentic_firm_id = ? AND status = ?';
    const args: unknown[] = [params.scenticFirmId, 'ACTIVE'];
    if (params.scenticUserId) { sql += ' AND scentic_user_id = ?'; args.push(params.scenticUserId); }
    if (params.scenticMatterId) { sql += ' AND scentic_matter_id = ?'; args.push(params.scenticMatterId); }
    const rows = this.db.prepare(sql).all(...args) as any[];
    return rows.map(r => this.rowToTimeEntryMapping(r));
  }

  // ── MappingStore: OpenSign Firm ────────────────────────────────────────
  async getOpenSignFirmMapping(scenticFirmId: string): Promise<OpenSignFirmMapping | null> {
    const row = this.db.prepare('SELECT * FROM opensign_firm_mappings WHERE scentic_firm_id = ?').get(scenticFirmId) as any;
    return row ? this.rowToOpenSignFirmMapping(row) : null;
  }

  async upsertOpenSignFirmMapping(params: SyncOpenSignFirmParams, opensignTenantId: string, opensignTenantName: string): Promise<OpenSignFirmMapping> {
    const existing = await this.getOpenSignFirmMapping(params.scenticFirmId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE opensign_firm_mappings SET opensign_tenant_id = ?, opensign_tenant_name = ?, updated_at = ? WHERE scentic_firm_id = ?')
        .run(opensignTenantId, opensignTenantName, ts, params.scenticFirmId);
      return { ...existing, opensignTenantId, opensignTenantName, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO opensign_firm_mappings (id, scentic_firm_id, opensign_tenant_id, opensign_tenant_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, opensignTenantId, opensignTenantName, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, opensignTenantId, opensignTenantName, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  async disableOpenSignFirmMapping(scenticFirmId: string): Promise<void> {
    this.db.prepare('UPDATE opensign_firm_mappings SET status = ?, updated_at = ? WHERE scentic_firm_id = ?')
      .run('DISABLED', now(), scenticFirmId);
  }

  // ── MappingStore: OpenSign User ────────────────────────────────────────
  async getOpenSignUserMapping(scenticFirmId: string, scenticUserId: string): Promise<OpenSignUserMapping | null> {
    const row = this.db.prepare('SELECT * FROM opensign_user_mappings WHERE scentic_firm_id = ? AND scentic_user_id = ?').get(scenticFirmId, scenticUserId) as any;
    return row ? this.rowToOpenSignUserMapping(row) : null;
  }

  async upsertOpenSignUserMapping(params: SyncOpenSignUserParams, opensignUserId: string, opensignSessionToken: string): Promise<OpenSignUserMapping> {
    const existing = await this.getOpenSignUserMapping(params.scenticFirmId, params.scenticUserId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE opensign_user_mappings SET opensign_user_id = ?, opensign_email = ?, opensign_session_token = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_user_id = ?')
        .run(opensignUserId, params.email, opensignSessionToken, ts, params.scenticFirmId, params.scenticUserId);
      return { ...existing, opensignUserId, opensignEmail: params.email, opensignSessionToken, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO opensign_user_mappings (id, scentic_firm_id, scentic_user_id, opensign_user_id, opensign_email, opensign_session_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, params.scenticUserId, opensignUserId, params.email, opensignSessionToken, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, scenticUserId: params.scenticUserId, opensignUserId, opensignEmail: params.email, opensignSessionToken, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  // ── MappingStore: OpenSign Workflow ────────────────────────────────────
  async getOpenSignWorkflowMapping(scenticFirmId: string, scenticSignatureWorkflowId: string): Promise<OpenSignWorkflowMapping | null> {
    const row = this.db.prepare('SELECT * FROM opensign_workflow_mappings WHERE scentic_firm_id = ? AND scentic_signature_workflow_id = ?').get(scenticFirmId, scenticSignatureWorkflowId) as any;
    return row ? this.rowToOpenSignWorkflowMapping(row) : null;
  }

  async upsertOpenSignWorkflowMapping(params: CreateOpenSignWorkflowParams, opensignDocumentId: string, opensignWorkflowId: string, opensignStatus: string): Promise<OpenSignWorkflowMapping> {
    const existing = await this.getOpenSignWorkflowMapping(params.scenticFirmId, params.scenticSignatureWorkflowId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE opensign_workflow_mappings SET opensign_document_id = ?, opensign_workflow_id = ?, opensign_status = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_signature_workflow_id = ?')
        .run(opensignDocumentId, opensignWorkflowId, opensignStatus, ts, params.scenticFirmId, params.scenticSignatureWorkflowId);
      return { ...existing, opensignDocumentId, opensignWorkflowId, opensignStatus, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO opensign_workflow_mappings (id, scentic_firm_id, scentic_signature_workflow_id, scentic_matter_id, scentic_document_id, scentic_document_version_id, opensign_document_id, opensign_workflow_id, opensign_status, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, params.scenticFirmId, params.scenticSignatureWorkflowId, params.scenticMatterId, params.scenticDocumentId, params.scenticDocumentVersionId, opensignDocumentId, opensignWorkflowId, opensignStatus, 'ACTIVE', ts, ts);
    return { id, scenticFirmId: params.scenticFirmId, scenticSignatureWorkflowId: params.scenticSignatureWorkflowId, scenticMatterId: params.scenticMatterId, scenticDocumentId: params.scenticDocumentId, scenticDocumentVersionId: params.scenticDocumentVersionId, opensignDocumentId, opensignWorkflowId, opensignStatus, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  async updateOpenSignWorkflowStatus(scenticFirmId: string, scenticSignatureWorkflowId: string, opensignStatus: string): Promise<void> {
    this.db.prepare('UPDATE opensign_workflow_mappings SET opensign_status = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_signature_workflow_id = ?')
      .run(opensignStatus, now(), scenticFirmId, scenticSignatureWorkflowId);
  }

  async listOpenSignWorkflowMappings(scenticFirmId: string): Promise<OpenSignWorkflowMapping[]> {
    const rows = this.db.prepare('SELECT * FROM opensign_workflow_mappings WHERE scentic_firm_id = ? AND status = ?').all(scenticFirmId, 'ACTIVE') as any[];
    return rows.map(r => this.rowToOpenSignWorkflowMapping(r));
  }

  // ── MappingStore: OpenSign Signer ──────────────────────────────────────
  async getOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string): Promise<OpenSignSignerMapping | null> {
    const row = this.db.prepare('SELECT * FROM opensign_signer_mappings WHERE scentic_firm_id = ? AND scentic_signature_workflow_id = ? AND scentic_signer_id = ?').get(scenticFirmId, scenticSignatureWorkflowId, scenticSignerId) as any;
    return row ? this.rowToOpenSignSignerMapping(row) : null;
  }

  async upsertOpenSignSignerMapping(scenticFirmId: string, scenticSignatureWorkflowId: string, scenticSignerId: string, opensignSignerId: string, signerEmailHash: string): Promise<OpenSignSignerMapping> {
    const existing = await this.getOpenSignSignerMapping(scenticFirmId, scenticSignatureWorkflowId, scenticSignerId);
    const ts = now();
    if (existing) {
      this.db.prepare('UPDATE opensign_signer_mappings SET opensign_signer_id = ?, signer_email_hash = ?, updated_at = ? WHERE scentic_firm_id = ? AND scentic_signature_workflow_id = ? AND scentic_signer_id = ?')
        .run(opensignSignerId, signerEmailHash, ts, scenticFirmId, scenticSignatureWorkflowId, scenticSignerId);
      return { ...existing, opensignSignerId, signerEmailHash, updatedAt: ts };
    }
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO opensign_signer_mappings (id, scentic_firm_id, scentic_signature_workflow_id, scentic_signer_id, opensign_signer_id, signer_email_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, scenticFirmId, scenticSignatureWorkflowId, scenticSignerId, opensignSignerId, signerEmailHash, 'ACTIVE', ts, ts);
    return { id, scenticFirmId, scenticSignatureWorkflowId, scenticSignerId, opensignSignerId, signerEmailHash, status: 'ACTIVE', createdAt: ts, updatedAt: ts };
  }

  // ── MappingStore: Utility ──────────────────────────────────────────────
  async clear(): Promise<void> {
    this.db.exec('DELETE FROM firm_mappings; DELETE FROM user_mappings; DELETE FROM client_mappings; DELETE FROM matter_mappings; DELETE FROM activity_mappings; DELETE FROM time_entry_mappings; DELETE FROM opensign_firm_mappings; DELETE FROM opensign_user_mappings; DELETE FROM opensign_workflow_mappings; DELETE FROM opensign_signer_mappings; DELETE FROM nonces; DELETE FROM idempotency_keys; DELETE FROM outbox_events;');
  }

  // ── NonceStore ─────────────────────────────────────────────────────────
  async seen(nonce: string, timestamp: number): Promise<boolean> {
    // Clean expired nonces
    const cutoff = Date.now() - this.maxAgeMs;
    this.db.prepare('DELETE FROM nonces WHERE timestamp < ?').run(cutoff);
    // Check existing
    const existing = this.db.prepare('SELECT nonce FROM nonces WHERE nonce = ?').get(nonce);
    if (existing) return true;
    this.db.prepare('INSERT INTO nonces (nonce, timestamp, created_at) VALUES (?, ?, ?)').run(nonce, timestamp, now());
    return false;
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
    this.db.prepare('INSERT INTO outbox_events (event_id, event_type, scentic_firm_id, correlation_id, created_at, payload, safe_summary, retry_count, max_retries, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fullEvent.eventId, fullEvent.eventType, fullEvent.scenticFirmId, fullEvent.correlationId, fullEvent.createdAt, JSON.stringify(fullEvent.payload), fullEvent.safeSummary, 0, 5, 'PENDING');
    return fullEvent;
  }

  async getPending(): Promise<OutboxEvent[]> {
    const rows = this.db.prepare('SELECT * FROM outbox_events WHERE status = ?').all('PENDING') as any[];
    return rows.map(r => this.rowToOutboxEvent(r));
  }

  async markSent(eventId: string): Promise<void> {
    this.db.prepare('UPDATE outbox_events SET status = ? WHERE event_id = ?').run('SENT', eventId);
  }

  async markFailed(eventId: string): Promise<void> {
    const event = this.db.prepare('SELECT retry_count, max_retries FROM outbox_events WHERE event_id = ?').get(eventId) as any;
    if (!event) return;
    const newRetryCount = event.retry_count + 1;
    const newStatus = newRetryCount >= event.max_retries ? 'FAILED' : 'PENDING';
    this.db.prepare('UPDATE outbox_events SET retry_count = ?, status = ? WHERE event_id = ?').run(newRetryCount, newStatus, eventId);
  }

  async getAll(): Promise<OutboxEvent[]> {
    const rows = this.db.prepare('SELECT * FROM outbox_events').all() as any[];
    return rows.map(r => this.rowToOutboxEvent(r));
  }

  // ── Row converters ─────────────────────────────────────────────────────
  private rowToFirmMapping(r: any): FirmMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, kimaiTeamId: r.kimai_team_id, kimaiTeamName: r.kimai_team_name, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToUserMapping(r: any): UserMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticUserId: r.scentic_user_id, kimaiUserId: r.kimai_user_id, kimaiUsername: r.kimai_username, kimaiApiToken: r.kimai_api_token, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToClientMapping(r: any): ClientMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticClientId: r.scentic_client_id, kimaiCustomerId: r.kimai_customer_id, displayLabelUsed: r.display_label_used, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToMatterMapping(r: any): MatterMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticMatterId: r.scentic_matter_id, scenticClientId: r.scentic_client_id, kimaiProjectId: r.kimai_project_id, displayLabelUsed: r.display_label_used, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToActivityMapping(r: any): ActivityMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticActivityCode: r.scentic_activity_code, kimaiActivityId: r.kimai_activity_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToTimeEntryMapping(r: any): TimeEntryMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticTimeEntryId: r.scentic_time_entry_id, kimaiTimesheetId: r.kimai_timesheet_id, scenticMatterId: r.scentic_matter_id, scenticUserId: r.scentic_user_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToOpenSignFirmMapping(r: any): OpenSignFirmMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, opensignTenantId: r.opensign_tenant_id, opensignTenantName: r.opensign_tenant_name, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToOpenSignUserMapping(r: any): OpenSignUserMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticUserId: r.scentic_user_id, opensignUserId: r.opensign_user_id, opensignEmail: r.opensign_email, opensignSessionToken: r.opensign_session_token, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToOpenSignWorkflowMapping(r: any): OpenSignWorkflowMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticSignatureWorkflowId: r.scentic_signature_workflow_id, scenticMatterId: r.scentic_matter_id, scenticDocumentId: r.scentic_document_id, scenticDocumentVersionId: r.scentic_document_version_id, opensignDocumentId: r.opensign_document_id, opensignWorkflowId: r.opensign_workflow_id, opensignStatus: r.opensign_status, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToOpenSignSignerMapping(r: any): OpenSignSignerMapping {
    return { id: r.id, scenticFirmId: r.scentic_firm_id, scenticSignatureWorkflowId: r.scentic_signature_workflow_id, scenticSignerId: r.scentic_signer_id, opensignSignerId: r.opensign_signer_id, signerEmailHash: r.signer_email_hash, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private rowToOutboxEvent(r: any): OutboxEvent {
    return { eventId: r.event_id, eventType: r.event_type, scenticFirmId: r.scentic_firm_id, correlationId: r.correlation_id, createdAt: r.created_at, payload: JSON.parse(r.payload), safeSummary: r.safe_summary, retryCount: r.retry_count, maxRetries: r.max_retries, status: r.status };
  }
}
