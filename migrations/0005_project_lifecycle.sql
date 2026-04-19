-- ============================================================
-- CF Agent Memory — Project lifecycle
-- ============================================================
-- Adds an archived flag so projects can be hidden from lists
-- without losing their data, and seeds 'default' so the built-in
-- fallback project always exists even when the middleware no
-- longer auto-creates unknown IDs.

ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_projects_archived ON projects(archived);

INSERT OR IGNORE INTO projects (id, display_name) VALUES ('default', 'Default');
