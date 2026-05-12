import { createMiddleware } from 'hono/factory';
import type { AppType } from '../types';
import { isValidScopeId } from '../utils/ids';

const KNOWN_USERS_MAX = 1024;
const knownUsers = new Set<string>();

function rememberKnown(id: string): void {
  if (knownUsers.has(id)) return;
  if (knownUsers.size >= KNOWN_USERS_MAX) {
    const oldest = knownUsers.values().next().value;
    if (oldest !== undefined) knownUsers.delete(oldest);
  }
  knownUsers.add(id);
}

export const userScopeMiddleware = createMiddleware<AppType>(async (c, next) => {
  // The project-scope middleware that ran first may already have populated
  // userId via a verified ws_token. Honour that and skip re-resolution.
  const existing = c.get('userId');
  if (existing) {
    if (!knownUsers.has(existing)) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)`
      )
        .bind(existing, existing)
        .run();
      rememberKnown(existing);
    }
    await next();
    return;
  }

  const headerId = c.req.header('X-User-Id');
  const queryId = c.req.query('user_id');

  if (headerId && queryId && headerId !== queryId) {
    return c.json(
      { error: 'Conflicting X-User-Id header and user_id query param' },
      400
    );
  }

  let userId: string;
  if (headerId) {
    userId = headerId;
  } else if (queryId) {
    if (c.req.method !== 'GET') {
      return c.json(
        {
          error:
            'user_id query param is only accepted on GET requests; use the X-User-Id header for writes',
        },
        400
      );
    }
    userId = queryId;
  } else {
    userId = 'default';
  }

  if (!isValidScopeId(userId)) {
    return c.json(
      { error: 'Invalid user_id: must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63}' },
      400
    );
  }

  if (!knownUsers.has(userId)) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, display_name) VALUES (?, ?)`
    )
      .bind(userId, userId)
      .run();
    rememberKnown(userId);
  }

  c.set('userId', userId);
  await next();
});
