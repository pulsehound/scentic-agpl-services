-- SQLite schema for gateway durable state.
-- All mapping tables are Firm-scoped (scentic_firm_id column).
-- No document contents, raw signer emails, or secrets stored.

CREATE TABLE IF NOT EXISTS firm_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT UNIQUE NOT NULL,
  kimai_team_id INTEGER NOT NULL,
  kimai_team_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_user_id TEXT NOT NULL,
  kimai_user_id INTEGER NOT NULL,
  kimai_username TEXT NOT NULL,
  kimai_api_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_user_id)
);

CREATE TABLE IF NOT EXISTS client_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_client_id TEXT NOT NULL,
  kimai_customer_id INTEGER NOT NULL,
  display_label_used TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_client_id)
);

CREATE TABLE IF NOT EXISTS matter_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_matter_id TEXT NOT NULL,
  scentic_client_id TEXT NOT NULL,
  kimai_project_id INTEGER NOT NULL,
  display_label_used TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_matter_id)
);

CREATE TABLE IF NOT EXISTS activity_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_activity_code TEXT NOT NULL,
  kimai_activity_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_activity_code)
);

CREATE TABLE IF NOT EXISTS time_entry_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_time_entry_id TEXT NOT NULL,
  kimai_timesheet_id INTEGER NOT NULL,
  scentic_matter_id TEXT NOT NULL,
  scentic_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_time_entry_id)
);

CREATE TABLE IF NOT EXISTS opensign_firm_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT UNIQUE NOT NULL,
  opensign_tenant_id TEXT NOT NULL,
  opensign_tenant_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opensign_user_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_user_id TEXT NOT NULL,
  opensign_user_id TEXT NOT NULL,
  opensign_email TEXT NOT NULL,
  opensign_session_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_user_id)
);

CREATE TABLE IF NOT EXISTS opensign_workflow_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_signature_workflow_id TEXT NOT NULL,
  scentic_matter_id TEXT NOT NULL,
  scentic_document_id TEXT NOT NULL,
  scentic_document_version_id TEXT NOT NULL,
  opensign_document_id TEXT NOT NULL,
  opensign_workflow_id TEXT NOT NULL,
  opensign_status TEXT NOT NULL DEFAULT 'DRAFT',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_signature_workflow_id)
);

CREATE TABLE IF NOT EXISTS opensign_signer_mappings (
  id TEXT PRIMARY KEY,
  scentic_firm_id TEXT NOT NULL,
  scentic_signature_workflow_id TEXT NOT NULL,
  scentic_signer_id TEXT NOT NULL,
  opensign_signer_id TEXT NOT NULL,
  signer_email_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scentic_firm_id, scentic_signature_workflow_id, scentic_signer_id)
);

CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nonces_timestamp ON nonces(timestamp);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  scentic_firm_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  safe_summary TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'PENDING'
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status);
CREATE INDEX IF NOT EXISTS idx_outbox_firm ON outbox_events(scentic_firm_id);
