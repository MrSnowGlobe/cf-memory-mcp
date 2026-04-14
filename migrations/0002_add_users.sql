-- ============================================================
-- CF Agent Memory — Add User Scope Dimension
-- ============================================================

-- User registry
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

-- Seed system users
INSERT INTO users (id, display_name) VALUES ('global', 'Global User');
INSERT INTO users (id, display_name) VALUES ('default', 'Default User');

-- ============================================================
-- Add user_id column to all scoped tables
-- ============================================================

ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE entities ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE preferences ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE facts ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE reasoning_traces ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';

-- Add source_user_id to promotion audit log
ALTER TABLE promotion_log ADD COLUMN source_user_id TEXT NOT NULL DEFAULT 'default';

-- ============================================================
-- Rebuild tool_stats with user_id in primary key
-- (SQLite cannot ALTER a PRIMARY KEY)
-- ============================================================

CREATE TABLE tool_stats_new (
  tool_name TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default',
  total_calls INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (tool_name, project_id, user_id)
);

INSERT INTO tool_stats_new (tool_name, project_id, user_id, total_calls, success_count, failure_count, total_duration_ms, last_used_at)
  SELECT tool_name, project_id, 'default', total_calls, success_count, failure_count, total_duration_ms, last_used_at
  FROM tool_stats;

DROP TABLE tool_stats;
ALTER TABLE tool_stats_new RENAME TO tool_stats;

-- ============================================================
-- Composite indexes for user-scoped queries
-- ============================================================

CREATE INDEX idx_sessions_project_user ON sessions(project_id, user_id, updated_at);
CREATE INDEX idx_entities_project_user ON entities(project_id, user_id, entity_type);
CREATE INDEX idx_preferences_project_user ON preferences(project_id, user_id, category);
CREATE INDEX idx_facts_project_user ON facts(project_id, user_id, subject);
CREATE INDEX idx_traces_project_user ON reasoning_traces(project_id, user_id, started_at);
