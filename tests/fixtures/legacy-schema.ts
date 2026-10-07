// Frozen from the uploaded v0.1.0 archive (schema version 2), not from current DDL.
export const LEGACY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  path TEXT NOT NULL,
  git_remote TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  current_turn INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  turn INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  input_kind TEXT NOT NULL,
  input_ref TEXT NOT NULL,
  input_sha TEXT NOT NULL,
  input_bytes INTEGER NOT NULL,
  result_kind TEXT NOT NULL,
  result_ref TEXT NOT NULL,
  result_sha TEXT NOT NULL,
  result_bytes INTEGER NOT NULL,
  descriptor_json TEXT NOT NULL,
  chain_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  persistent_pin INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'hot',
  safe_to_evict REAL,
  protected_until_turn INTEGER NOT NULL DEFAULT 0,
  recalled_count INTEGER NOT NULL DEFAULT 0,
  last_recalled_at INTEGER,
  capsule_id TEXT,
  UNIQUE(agent, workspace_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS chains (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  capsule_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chain_members (
  chain_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (chain_id, event_id)
);

CREATE TABLE IF NOT EXISTS capsules (
  id TEXT PRIMARY KEY,
  source_event_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  anchors_json TEXT NOT NULL,
  outcome TEXT,
  frozen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS retention_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  scorer TEXT NOT NULL,
  safe_to_evict REAL NOT NULL,
  turn INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  score REAL,
  turn INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recalled_at INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  decision_turn INTEGER,
  turns_until_recall INTEGER,
  safe_to_evict REAL,
  decision TEXT
);

CREATE TABLE IF NOT EXISTS pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  session_id TEXT,
  persistent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(target_type, target_id, session_id)
);

CREATE TABLE IF NOT EXISTS provider_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stats (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS host_usage (
  session_id TEXT PRIMARY KEY,
  context_window INTEGER NOT NULL,
  used_tokens INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_state ON tool_events(session_id, state);
CREATE INDEX IF NOT EXISTS idx_events_chain ON tool_events(chain_id);
CREATE INDEX IF NOT EXISTS idx_events_session_turn ON tool_events(session_id, turn);
CREATE INDEX IF NOT EXISTS idx_decisions_event ON decisions(event_id);
CREATE INDEX IF NOT EXISTS idx_scores_event ON retention_scores(event_id);
CREATE INDEX IF NOT EXISTS idx_events_state_archived ON tool_events(state, archived_at);
`;
