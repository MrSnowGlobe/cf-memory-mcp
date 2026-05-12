import type { Context } from 'hono';
import type { AppType, Bindings } from '../types';
import { generateId } from '../utils/ids';
import { adminCallerFingerprint } from '../middleware/admin-auth';
import { logError } from '../services/logger';

export interface AuditInput {
  route: string;
  method: string;
  target: string | null;
  status: number;
  outcome: string | null;
}

/**
 * Append a row to the admin_audit table. Best-effort: a failed write is logged
 * and swallowed so the underlying admin operation's return value still
 * reaches the caller. The audit is for observability, not authorisation.
 */
export async function recordAdminAudit(
  c: Context<AppType>,
  input: AuditInput
): Promise<void> {
  const env: Bindings = c.env;
  try {
    const fp = await adminCallerFingerprint(c.req.header('X-Admin-Token'));
    await env.DB.prepare(
      `INSERT INTO admin_audit (id, ts, route, method, target, status, outcome, caller_fingerprint, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        generateId(),
        new Date().toISOString(),
        input.route,
        input.method,
        input.target,
        input.status,
        input.outcome,
        fp,
        c.get('requestId') ?? null
      )
      .run();
  } catch (err) {
    logError('admin_audit_write_failed', err, {
      component: 'admin-audit',
      path: input.route,
    });
  }
}
