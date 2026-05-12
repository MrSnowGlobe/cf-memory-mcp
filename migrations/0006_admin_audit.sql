-- ============================================================
-- CF Agent Memory — Admin audit log
-- ============================================================
-- One row per /api/v1/admin/* invocation. Records who called what,
-- when, and how it ended. Auth identity is captured as the first
-- 8 hex chars of SHA-256(ADMIN_TOKEN) so a token rotation can be
-- correlated against historical rows without storing the secret.

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  target TEXT,
  status INTEGER NOT NULL,
  outcome TEXT,
  caller_fingerprint TEXT,
  request_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit(ts);
CREATE INDEX IF NOT EXISTS idx_admin_audit_route ON admin_audit(route);
