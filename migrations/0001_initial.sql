-- ============================================================
-- CF Agent Memory — Initial Schema
-- ============================================================

-- Project registry
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

-- Seed the global project (always exists)
INSERT INTO projects (id, display_name) VALUES ('global', 'Global Memory');

-- ============================================================
-- Short-Term Memory
-- ============================================================

-- Conversations / Sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT 'default' REFERENCES projects(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);
CREATE INDEX idx_sessions_project ON sessions(project_id, updated_at);

-- Messages within sessions
CREATE TABLE messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sequence_num INTEGER NOT NULL,
  vector_id TEXT
);
CREATE INDEX idx_messages_session ON messages(session_id, sequence_num);
CREATE INDEX idx_messages_created ON messages(created_at);

-- ============================================================
-- Long-Term Memory
-- ============================================================

-- Entities (POLE+O simplified)
CREATE TABLE entities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL DEFAULT 'default' REFERENCES projects(id),
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'PERSON', 'OBJECT', 'LOCATION', 'EVENT', 'ORGANIZATION', 'CUSTOM'
  )),
  subtype TEXT,
  description TEXT,
  promoted_from TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  vector_id TEXT
);
CREATE INDEX idx_entities_project ON entities(project_id, entity_type);
CREATE INDEX idx_entities_name ON entities(name);

-- Entity relationships
CREATE TABLE entity_relations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_entity_id, target_entity_id, relation_type)
);
CREATE INDEX idx_relations_source ON entity_relations(source_entity_id);
CREATE INDEX idx_relations_target ON entity_relations(target_entity_id);

-- Preferences
CREATE TABLE preferences (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL DEFAULT 'default' REFERENCES projects(id),
  category TEXT NOT NULL,
  preference TEXT NOT NULL,
  context TEXT,
  confidence REAL DEFAULT 1.0,
  promoted_from TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  vector_id TEXT
);
CREATE INDEX idx_preferences_project ON preferences(project_id, category);

-- Facts (temporal knowledge)
CREATE TABLE facts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL DEFAULT 'default' REFERENCES projects(id),
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  confidence REAL DEFAULT 1.0,
  source TEXT,
  promoted_from TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  vector_id TEXT
);
CREATE INDEX idx_facts_project ON facts(project_id, subject);
CREATE INDEX idx_facts_predicate ON facts(predicate);

-- ============================================================
-- Procedural Memory
-- ============================================================

-- Reasoning traces
CREATE TABLE reasoning_traces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL DEFAULT 'default' REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id),
  task TEXT NOT NULL,
  outcome TEXT,
  success INTEGER,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms INTEGER,
  triggered_by_message_id TEXT REFERENCES messages(id),
  metadata TEXT DEFAULT '{}',
  vector_id TEXT
);
CREATE INDEX idx_traces_project ON reasoning_traces(project_id, started_at);
CREATE INDEX idx_traces_session ON reasoning_traces(session_id);

-- Reasoning steps within a trace
CREATE TABLE reasoning_steps (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trace_id TEXT NOT NULL REFERENCES reasoning_traces(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  thought TEXT,
  action TEXT,
  observation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_steps_trace ON reasoning_steps(trace_id, step_number);

-- Tool calls within a step
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  step_id TEXT NOT NULL REFERENCES reasoning_steps(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  arguments TEXT DEFAULT '{}',
  result TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'timeout')),
  duration_ms INTEGER,
  message_id TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tool_calls_step ON tool_calls(step_id);
CREATE INDEX idx_tool_calls_tool ON tool_calls(tool_name);

-- Pre-aggregated tool stats (scoped per project)
CREATE TABLE tool_stats (
  tool_name TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT 'default' REFERENCES projects(id),
  total_calls INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  total_duration_ms INTEGER DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (tool_name, project_id)
);

-- Promotion audit log
CREATE TABLE promotion_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_project_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  global_record_id TEXT NOT NULL,
  reason TEXT,
  promoted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
