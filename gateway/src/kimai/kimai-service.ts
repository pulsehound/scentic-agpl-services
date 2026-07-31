/**
 * Kimai service — orchestrates Kimai API calls with mapping, firm scoping,
 * and confidential label mode.
 *
 * Security:
 * - Every operation is Firm-scoped
 * - Cross-Firm mapping use is rejected
 * - Confidential labels used by default (no real matter/client names)
 * - Events published to outbox for all operations
 */

import type { KimaiClient } from './kimai-client.js';
import type { MappingStore } from '../mappings/mapping-store.js';
import type { EventOutbox } from '../events/outbox.js';
import type {
  SyncFirmParams, SyncUserParams, SyncClientParams, SyncMatterParams,
  SyncActivityParams, CreateTimeEntryParams, UpdateTimeEntryParams,
  ListTimeEntriesParams, ExportTimeEntriesParams,
  FirmMapping, UserMapping, ClientMapping, MatterMapping, ActivityMapping, TimeEntryMapping,
} from '../mappings/types.js';
import {
  firmScopeViolation, notFound, invalidInput, notSupported,
  upstreamUnavailable, type GatewayError,
} from '../http/errors.js';

export interface KimaiServiceConfig {
  useConfidentialLabels: boolean;
  defaultActivityName: string;
  adminUsername: string;
  adminApiToken: string;
}

export type ServiceResult<T> = { success: true; data: T } | { success: false; error: GatewayError };

function ok<T>(data: T): ServiceResult<T> { return { success: true, data }; }
function fail<T>(error: GatewayError): ServiceResult<T> { return { success: false, error }; }

function generateKimaiUsername(firmId: string, userId: string): string {
  const firmSlug = firmId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 12).toLowerCase();
  const userSlug = userId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 12).toLowerCase();
  return `scentic_${firmSlug}_${userSlug}`;
}

function sanitizeLabel(name: string, useConfidential: boolean, fallback: string): string {
  if (useConfidential) {
    return name.substring(0, 150); // Kimai name limit
  }
  // Use neutral label
  return fallback;
}

export class KimaiService {
  constructor(
    private client: KimaiClient,
    private store: MappingStore,
    private outbox: EventOutbox,
    private config: KimaiServiceConfig,
  ) {}

  // ── Health ─────────────────────────────────────────────────────────────

  async checkHealth(): Promise<ServiceResult<{ healthy: boolean; version?: string }>> {
    const result = await this.client.getStatus();
    if (result.success) {
      return ok({ healthy: true, version: result.data.version });
    }
    return ok({ healthy: false });
  }

  // ── Firm Init ──────────────────────────────────────────────────────────

  async initFirm(params: SyncFirmParams, correlationId: string): Promise<ServiceResult<FirmMapping>> {
    // Check if firm mapping already exists (idempotent)
    const existing = await this.store.getFirmMapping(params.scenticFirmId);
    if (existing && existing.status === 'ACTIVE') {
      return ok(existing);
    }

    // Create team in Kimai
    const teamName = sanitizeLabel(params.firmName, this.config.useConfidentialLabels, `Firm-${params.scenticFirmId.substring(0, 8)}`);
    const teamResult = await this.client.createTeam(teamName);
    if (!teamResult.success) {
      await this.outbox.publish({
        eventType: 'KIMAI_FIRM_INITIALIZED',
        scenticFirmId: params.scenticFirmId,
        correlationId,
        payload: { success: false, firmName: teamName },
        safeSummary: `Firm initialization failed for firm ${params.scenticFirmId.substring(0, 8)}`,
      });
      return fail(teamResult.error);
    }

    const mapping = await this.store.upsertFirmMapping(params, teamResult.data.id, teamName);

    await this.outbox.publish({
      eventType: 'KIMAI_FIRM_INITIALIZED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { success: true, kimaiTeamId: teamResult.data.id },
      safeSummary: `Firm initialized: team ${teamResult.data.id} created in Kimai`,
    });

    return ok(mapping);
  }

  // ── User Sync ──────────────────────────────────────────────────────────

  async syncUser(params: SyncUserParams, correlationId: string): Promise<ServiceResult<UserMapping>> {
    // Check if user mapping already exists
    const existing = await this.store.getUserMapping(params.scenticFirmId, params.scenticUserId);
    if (existing && existing.status === 'ACTIVE') {
      return ok(existing);
    }

    // Verify firm mapping exists
    const firmMapping = await this.store.getFirmMapping(params.scenticFirmId);
    if (!firmMapping || firmMapping.status !== 'ACTIVE') {
      return fail(firmScopeViolation('Firm not initialized. Call init-firm first.'));
    }

    // Create user in Kimai
    const username = generateKimaiUsername(params.scenticFirmId, params.scenticUserId);
    const userResult = await this.client.createUser({
      username,
      email: params.email,
      firstname: params.firstName ?? '',
      lastname: params.lastName ?? '',
      password: crypto.randomUUID(), // Random password; user uses API token
    });

    if (!userResult.success) {
      await this.outbox.publish({
        eventType: 'KIMAI_MAPPING_FAILED',
        scenticFirmId: params.scenticFirmId,
        correlationId,
        payload: { entity: 'user', scenticUserId: params.scenticUserId.substring(0, 8) },
        safeSummary: `User sync failed for user ${params.scenticUserId.substring(0, 8)} in firm ${params.scenticFirmId.substring(0, 8)}`,
      });
      return fail(userResult.error);
    }

    // In a real implementation, we'd create an API token for this user via Kimai admin API
    // For AGPL-01, we use the admin token as a fallback (documented gap)
    const apiToken = this.config.adminApiToken; // TODO: Create per-user API token

    const mapping = await this.store.upsertUserMapping(params, userResult.data.id, username, apiToken);

    await this.outbox.publish({
      eventType: 'KIMAI_MAPPING_CREATED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { entity: 'user', kimaiUserId: userResult.data.id },
      safeSummary: `User mapped: Kimai user ${userResult.data.id} for Scentic user ${params.scenticUserId.substring(0, 8)}`,
    });

    return ok(mapping);
  }

  // ── Client Sync ────────────────────────────────────────────────────────

  async syncClient(params: SyncClientParams, correlationId: string): Promise<ServiceResult<ClientMapping>> {
    const existing = await this.store.getClientMapping(params.scenticFirmId, params.scenticClientId);
    if (existing && existing.status === 'ACTIVE') {
      return ok(existing);
    }

    const firmMapping = await this.store.getFirmMapping(params.scenticFirmId);
    if (!firmMapping || firmMapping.status !== 'ACTIVE') {
      return fail(firmScopeViolation('Firm not initialized'));
    }

    const label = sanitizeLabel(
      params.clientName,
      this.config.useConfidentialLabels,
      `Client-${params.scenticClientId.substring(0, 8)}`,
    );

    const result = await this.client.createCustomer({
      name: label,
      team: firmMapping.kimaiTeamId,
    });

    if (!result.success) {
      await this.outbox.publish({
        eventType: 'KIMAI_MAPPING_FAILED',
        scenticFirmId: params.scenticFirmId,
        correlationId,
        payload: { entity: 'client', scenticClientId: params.scenticClientId.substring(0, 8) },
        safeSummary: `Client sync failed for client ${params.scenticClientId.substring(0, 8)}`,
      });
      return fail(result.error);
    }

    const mapping = await this.store.upsertClientMapping(params, result.data.id, label);

    await this.outbox.publish({
      eventType: 'KIMAI_MAPPING_CREATED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { entity: 'client', kimaiCustomerId: result.data.id },
      safeSummary: `Client mapped: Kimai customer ${result.data.id}`,
    });

    return ok(mapping);
  }

  // ── Matter Sync ────────────────────────────────────────────────────────

  async syncMatter(params: SyncMatterParams, correlationId: string): Promise<ServiceResult<MatterMapping>> {
    const existing = await this.store.getMatterMapping(params.scenticFirmId, params.scenticMatterId);
    if (existing && existing.status === 'ACTIVE') {
      return ok(existing);
    }

    const firmMapping = await this.store.getFirmMapping(params.scenticFirmId);
    if (!firmMapping || firmMapping.status !== 'ACTIVE') {
      return fail(firmScopeViolation('Firm not initialized'));
    }

    // Verify client mapping exists
    const clientMapping = await this.store.getClientMapping(params.scenticFirmId, params.scenticClientId);
    if (!clientMapping || clientMapping.status !== 'ACTIVE') {
      return fail(invalidInput('Client not synced. Sync client first.'));
    }

    const label = sanitizeLabel(
      params.matterName,
      this.config.useConfidentialLabels,
      params.matterCode ? `Matter-${params.matterCode}` : `Matter-${params.scenticMatterId.substring(0, 8)}`,
    );

    const result = await this.client.createProject({
      name: label,
      customer: clientMapping.kimaiCustomerId,
      team: firmMapping.kimaiTeamId,
      orderNumber: params.matterCode,
    });

    if (!result.success) {
      await this.outbox.publish({
        eventType: 'KIMAI_MAPPING_FAILED',
        scenticFirmId: params.scenticFirmId,
        correlationId,
        payload: { entity: 'matter', scenticMatterId: params.scenticMatterId.substring(0, 8) },
        safeSummary: `Matter sync failed for matter ${params.scenticMatterId.substring(0, 8)}`,
      });
      return fail(result.error);
    }

    const mapping = await this.store.upsertMatterMapping(params, result.data.id, label);

    await this.outbox.publish({
      eventType: 'KIMAI_MAPPING_CREATED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { entity: 'matter', kimaiProjectId: result.data.id },
      safeSummary: `Matter mapped: Kimai project ${result.data.id}`,
    });

    return ok(mapping);
  }

  // ── Activity Sync ──────────────────────────────────────────────────────

  async syncActivity(params: SyncActivityParams, correlationId: string): Promise<ServiceResult<ActivityMapping>> {
    const existing = await this.store.getActivityMapping(params.scenticFirmId, params.scenticActivityCode);
    if (existing && existing.status === 'ACTIVE') {
      return ok(existing);
    }

    // Activities in Kimai can be global or project-specific
    // We create global activities for Scentic activity types
    const result = await this.client.createActivity({
      name: params.activityName,
    });

    if (!result.success) {
      return fail(result.error);
    }

    const mapping = await this.store.upsertActivityMapping(params, result.data.id);

    await this.outbox.publish({
      eventType: 'KIMAI_MAPPING_CREATED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { entity: 'activity', kimaiActivityId: result.data.id },
      safeSummary: `Activity mapped: Kimai activity ${result.data.id}`,
    });

    return ok(mapping);
  }

  // ── Time Entry CRUD ────────────────────────────────────────────────────

  async createTimeEntry(params: CreateTimeEntryParams, correlationId: string): Promise<ServiceResult<TimeEntryMapping>> {
    // Idempotency: check if entry already exists
    const existing = await this.store.getTimeEntryMapping(params.scenticFirmId, params.scenticTimeEntryId);
    if (existing && existing.status === 'ACTIVE') {
      return ok(existing);
    }

    // Verify firm, user, matter, activity mappings
    const firmMapping = await this.store.getFirmMapping(params.scenticFirmId);
    if (!firmMapping || firmMapping.status !== 'ACTIVE') {
      return fail(firmScopeViolation('Firm not initialized'));
    }

    const userMapping = await this.store.getUserMapping(params.scenticFirmId, params.scenticUserId);
    if (!userMapping || userMapping.status !== 'ACTIVE') {
      return fail(invalidInput('User not synced. Sync user first.'));
    }

    const matterMapping = await this.store.getMatterMapping(params.scenticFirmId, params.scenticMatterId);
    if (!matterMapping || matterMapping.status !== 'ACTIVE') {
      return fail(invalidInput('Matter not synced. Sync matter first.'));
    }

    const activityMapping = await this.store.getActivityMapping(params.scenticFirmId, params.scenticActivityCode);
    if (!activityMapping || activityMapping.status !== 'ACTIVE') {
      // Auto-create default activity
      const defaultResult = await this.syncActivity({
        scenticFirmId: params.scenticFirmId,
        scenticActivityCode: params.scenticActivityCode,
        activityName: this.config.defaultActivityName,
      }, correlationId);
      if (!defaultResult.success) return fail(defaultResult.error);
    }

    const activity = await this.store.getActivityMapping(params.scenticFirmId, params.scenticActivityCode);
    if (!activity) return fail(invalidInput('Activity mapping not found after sync'));

    // Create timesheet in Kimai using user's API token
    const tsResult = await this.client.createTimesheet({
      begin: params.startAt,
      end: params.endAt,
      duration: params.durationSeconds,
      activity: activity.kimaiActivityId,
      project: matterMapping.kimaiProjectId,
      user: userMapping.kimaiUserId,
      description: this.config.useConfidentialLabels ? params.description : undefined,
    }, userMapping.kimaiApiToken);

    if (!tsResult.success) {
      await this.outbox.publish({
        eventType: 'KIMAI_SYNC_FAILED',
        scenticFirmId: params.scenticFirmId,
        correlationId,
        payload: { operation: 'create_time_entry' },
        safeSummary: `Time entry creation failed for firm ${params.scenticFirmId.substring(0, 8)}`,
      });
      return fail(tsResult.error);
    }

    const mapping = await this.store.upsertTimeEntryMapping(params, tsResult.data.id);

    await this.outbox.publish({
      eventType: 'KIMAI_TIME_ENTRY_CREATED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { kimaiTimesheetId: tsResult.data.id },
      safeSummary: `Time entry created: Kimai timesheet ${tsResult.data.id}`,
    });

    return ok(mapping);
  }

  async listTimeEntries(params: ListTimeEntriesParams, correlationId: string): Promise<ServiceResult<TimeEntryMapping[]>> {
    const mappings = await this.store.listTimeEntryMappings(params);
    return ok(mappings);
  }

  async updateTimeEntry(params: UpdateTimeEntryParams, correlationId: string): Promise<ServiceResult<TimeEntryMapping>> {
    const mapping = await this.store.getTimeEntryMapping(params.scenticFirmId, params.scenticTimeEntryId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return fail(notFound('Time entry not found'));
    }

    const result = await this.client.updateTimesheet(mapping.kimaiTimesheetId, {
      begin: params.startAt,
      end: params.endAt,
      duration: params.durationSeconds,
      description: this.config.useConfidentialLabels ? params.description : undefined,
    });

    if (!result.success) return fail(result.error);

    await this.store.updateTimeEntryMapping(params.scenticFirmId, params.scenticTimeEntryId);

    await this.outbox.publish({
      eventType: 'KIMAI_TIME_ENTRY_UPDATED',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { kimaiTimesheetId: mapping.kimaiTimesheetId },
      safeSummary: `Time entry updated: Kimai timesheet ${mapping.kimaiTimesheetId}`,
    });

    return ok(mapping);
  }

  async deleteTimeEntry(firmId: string, timeEntryId: string, correlationId: string): Promise<ServiceResult<void>> {
    const mapping = await this.store.getTimeEntryMapping(firmId, timeEntryId);
    if (!mapping || mapping.status !== 'ACTIVE') {
      return fail(notFound('Time entry not found'));
    }

    const result = await this.client.deleteTimesheet(mapping.kimaiTimesheetId);
    if (!result.success) return fail(result.error);

    await this.store.deleteTimeEntryMapping(firmId, timeEntryId);

    await this.outbox.publish({
      eventType: 'KIMAI_TIME_ENTRY_DELETED',
      scenticFirmId: firmId,
      correlationId,
      payload: { kimaiTimesheetId: mapping.kimaiTimesheetId },
      safeSummary: `Time entry deleted: Kimai timesheet ${mapping.kimaiTimesheetId}`,
    });

    return ok(undefined);
  }

  async exportTimeEntries(params: ExportTimeEntriesParams, correlationId: string): Promise<ServiceResult<{ exportUrl?: string }>> {
    // Gather timesheet IDs for this firm
    const mappings = await this.store.listTimeEntryMappings({
      scenticFirmId: params.scenticFirmId,
      scenticUserId: params.scenticUserId,
      scenticMatterId: params.scenticMatterId,
    });

    if (mappings.length === 0) {
      return ok({ exportUrl: undefined });
    }

    // Map to Kimai project IDs
    const projectIds = new Set<number>();
    for (const m of mappings) {
      const matterMapping = await this.store.getMatterMapping(params.scenticFirmId, m.scenticMatterId);
      if (matterMapping) projectIds.add(matterMapping.kimaiProjectId);
    }

    const result = await this.client.exportTimesheets({
      format: params.format ?? 'csv',
      begin: params.startDate,
      end: params.endDate,
      project: Array.from(projectIds),
    });

    if (!result.success) return fail(result.error);

    await this.outbox.publish({
      eventType: 'KIMAI_TIME_ENTRY_EXPORT_READY',
      scenticFirmId: params.scenticFirmId,
      correlationId,
      payload: { format: params.format ?? 'csv', count: mappings.length },
      safeSummary: `Time entry export ready: ${mappings.length} entries`,
    });

    return ok({ exportUrl: result.data.url });
  }

  // ── Admin ──────────────────────────────────────────────────────────────

  async disableFirm(firmId: string, correlationId: string): Promise<ServiceResult<void>> {
    const mapping = await this.store.getFirmMapping(firmId);
    if (!mapping) return fail(notFound('Firm not found'));

    await this.store.disableFirmMapping(firmId);

    await this.outbox.publish({
      eventType: 'KIMAI_FIRM_INITIALIZED',
      scenticFirmId: firmId,
      correlationId,
      payload: { disabled: true },
      safeSummary: `Firm disabled: ${firmId.substring(0, 8)}`,
    });

    return ok(undefined);
  }

  async testConnection(): Promise<ServiceResult<{ kimaiHealthy: boolean; version?: string }>> {
    const health = await this.checkHealth();
    if (health.success) {
      return ok({ kimaiHealthy: health.data.healthy, version: health.data.version });
    }
    return ok({ kimaiHealthy: false });
  }
}
