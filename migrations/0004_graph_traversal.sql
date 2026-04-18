-- ============================================================
-- CF Agent Memory — Graph traversal support
-- ============================================================

-- Per-edge weight; lets callers rank or decay relations later
-- without another migration. Defaults to 1.0 so existing edges
-- behave identically to before.
ALTER TABLE entity_relations ADD COLUMN relation_strength REAL NOT NULL DEFAULT 1.0;

-- Composite indexes accelerate filtered traversal:
--   "neighbors of X via relation_type T"
-- The plain idx_relations_source / idx_relations_target indexes
-- (created in 0001) already cover unfiltered traversal.
CREATE INDEX idx_relations_source_type ON entity_relations(source_entity_id, relation_type);
CREATE INDEX idx_relations_target_type ON entity_relations(target_entity_id, relation_type);
