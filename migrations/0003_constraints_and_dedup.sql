-- ============================================================
-- CF Agent Memory — Uniqueness constraints & promotion dedup
-- ============================================================

-- Prevent duplicate sequence numbers within a session.
-- Closes the addMessage race in short-term memory.
CREATE UNIQUE INDEX idx_messages_session_seq_unique
  ON messages(session_id, sequence_num);

-- Case-insensitive uniqueness for entities within a scope.
-- Closes the addEntity resolve-then-insert race and
-- prevents rename-to-existing in updateEntity.
CREATE UNIQUE INDEX idx_entities_scope_name_unique
  ON entities(project_id, user_id, entity_type, LOWER(name));

-- Track promotion target scope so the same record can't be promoted
-- twice to the same scope.
ALTER TABLE promotion_log ADD COLUMN target_scope TEXT NOT NULL DEFAULT 'global';

CREATE UNIQUE INDEX idx_promotion_log_dedup
  ON promotion_log(source_project_id, source_user_id, target_type, source_record_id, target_scope);
