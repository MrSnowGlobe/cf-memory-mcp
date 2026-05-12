export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Charset for project_id / user_id values. Tight enough that the same string
 * is safe to use as a KV-key segment, a Vectorize namespace, a DO-id seed,
 * and a structured-log field without escaping. First char must be
 * alphanumeric so an id can't collide with a control-prefix; subsequent
 * chars allow `_` and `-`. Length cap matches what KV / Vectorize accept
 * comfortably without truncation surprises.
 */
const SCOPE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function isValidScopeId(id: unknown): id is string {
  return typeof id === 'string' && SCOPE_ID_PATTERN.test(id);
}
