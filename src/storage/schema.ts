/**
 * Base SQLite DDL plus ordered migrations to the current archive schema.
 * Single source of truth for the storage schema (PRD §22, §42).
 */
export const SCHEMA_SQL = `
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
  UNIQUE(agent, workspace_id, session_id, tool_call_id)
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

/**
 * Schema version for databases created/migrated by this code.
 * Bumped when SCHEMA_SQL changes in a way that needs migration.
 */
export const SCHEMA_VERSION = 4;

type DbLike = {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
};
function columns(db: DbLike, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>).map(r => r.name));
}
/** Single writer lock, forward-version refusal, lossless v0.1 -> v0.2 upgrade. */
export function runMigrations(db: DbLike): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = (db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version;
    if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported ${SCHEMA_VERSION}; refusing to downgrade`);
    // Under the write lock taken by BEGIN IMMEDIATE: as separate autocommit statements, a process
    // creating tables while another writes could get SQLITE_BUSY without busy_timeout being used.
    db.exec(SCHEMA_SQL);
    const recall = columns(db, 'recall_log');
    if (!recall.has('safe_to_evict')) db.exec('ALTER TABLE recall_log ADD COLUMN safe_to_evict REAL');
    if (!recall.has('decision')) db.exec('ALTER TABLE recall_log ADD COLUMN decision TEXT');
    if (version < 3) {
      db.exec(`CREATE TABLE pins_upgrade (
        id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        session_id TEXT, persistent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        UNIQUE(target_type, target_id, session_id));
        INSERT INTO pins_upgrade SELECT * FROM pins;
        DROP TABLE pins; ALTER TABLE pins_upgrade RENAME TO pins;
        UPDATE pins SET persistent = (SELECT MAX(p.persistent) FROM pins p
          WHERE p.target_type = pins.target_type AND p.target_id = pins.target_id AND p.session_id IS pins.session_id);
        DELETE FROM pins WHERE id NOT IN (SELECT MIN(id) FROM pins GROUP BY target_type, target_id, session_id);
        CREATE UNIQUE INDEX idx_pins_scope ON pins(target_type, target_id, COALESCE(session_id, ''));
      `);
      const oldSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'tool_events'").get() as {sql: string}).sql;
      const updated = oldSql.replace(/CREATE TABLE(?: IF NOT EXISTS)? ["`]?tool_events["`]?/i, 'CREATE TABLE tool_events_upgrade')
        .replace('UNIQUE(agent, workspace_id, tool_call_id)', 'UNIQUE(agent, workspace_id, session_id, tool_call_id)');
      // Host session IDs are namespaced; a session-blind key would merge distinct invocations.
      if (!updated.includes('UNIQUE(agent, workspace_id, session_id, tool_call_id)'))
        throw new Error('Unrecognized legacy tool_events definition; refusing a migration that could merge sessions');
      db.exec(updated);
      db.exec(`INSERT INTO tool_events_upgrade SELECT * FROM tool_events;
        DROP TABLE tool_events; ALTER TABLE tool_events_upgrade RENAME TO tool_events;
        CREATE TABLE workspaces_upgrade (
          id TEXT NOT NULL, agent TEXT NOT NULL, path TEXT NOT NULL, git_remote TEXT,
          created_at INTEGER NOT NULL, PRIMARY KEY(agent, id));
        INSERT OR IGNORE INTO workspaces_upgrade SELECT id, agent, path, git_remote, created_at FROM workspaces;
        INSERT OR IGNORE INTO workspaces_upgrade SELECT workspace_id, agent, workspace_id, NULL, created_at FROM sessions;
        DROP TABLE workspaces; ALTER TABLE workspaces_upgrade RENAME TO workspaces;
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_views (
        event_id TEXT NOT NULL, session_id TEXT NOT NULL, turn INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'hot', protected_until_turn INTEGER NOT NULL DEFAULT 0,
        capsule_id TEXT, safe_to_evict REAL, recalled_count INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER, PRIMARY KEY(event_id, session_id));
      CREATE INDEX IF NOT EXISTS idx_views_session ON event_views(session_id, state);
      CREATE TABLE IF NOT EXISTS archive_tombstones (
        event_id TEXT PRIMARY KEY, agent TEXT NOT NULL, workspace_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL, deleted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS integration_health (
        agent TEXT NOT NULL, workspace_id TEXT NOT NULL, mode TEXT NOT NULL,
        last_seen INTEGER NOT NULL, observations INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, PRIMARY KEY(agent, workspace_id, mode));
      CREATE TABLE IF NOT EXISTS projections (
      event_id TEXT NOT NULL, mode TEXT NOT NULL, session_id TEXT NOT NULL,
      original_chars INTEGER NOT NULL, visible_chars INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(event_id,mode,session_id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS archive_search USING fts5(
        event_id UNINDEXED, agent UNINDEXED, workspace UNINDEXED, tool, body,
        tokenize = 'unicode61 remove_diacritics 2');
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS evidence_provenance (
        event_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_chunks USING fts5(
        event_id UNINDEXED, field UNINDEXED, start_offset UNINDEXED, end_offset UNINDEXED, body,
        tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS evidence_index (
        event_id TEXT NOT NULL, field TEXT NOT NULL, indexed_chars INTEGER NOT NULL,
        total_chars INTEGER NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(event_id,field));
      CREATE TABLE IF NOT EXISTS evidence_links (
        from_event TEXT NOT NULL, to_event TEXT NOT NULL, relation TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(from_event,to_event));
      CREATE TABLE IF NOT EXISTS projection_cache (
        event_id TEXT NOT NULL, session_id TEXT NOT NULL, mode TEXT NOT NULL, representation TEXT NOT NULL,
        source_sha TEXT NOT NULL, visible_sha TEXT NOT NULL, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(event_id,session_id,mode,representation));
      CREATE TABLE IF NOT EXISTS history_batches (
        session_id TEXT PRIMARY KEY, last_turn INTEGER NOT NULL, batches INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL, before_chars INTEGER NOT NULL, after_chars INTEGER NOT NULL,
        changed_events INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS evidence_cleanup AFTER DELETE ON tool_events BEGIN
        DELETE FROM evidence_links WHERE from_event=OLD.id OR to_event=OLD.id;
        DELETE FROM evidence_provenance WHERE event_id=OLD.id;
        DELETE FROM evidence_chunks WHERE event_id=OLD.id;
        DELETE FROM evidence_index WHERE event_id=OLD.id;
        DELETE FROM projection_cache WHERE event_id=OLD.id;
      END;
    `);
    const usage = columns(db, 'host_usage');
    if (!usage.has('managed_tokens')) db.exec('ALTER TABLE host_usage ADD COLUMN managed_tokens INTEGER NOT NULL DEFAULT 0');
    // Index old archives by metadata immediately. Reindex can include their payloads later.
    if (version < 3) db.exec(`INSERT INTO archive_search(event_id, agent, workspace, tool, body)
      SELECT id, agent, workspace_id, tool_name, descriptor_json FROM tool_events`);
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
