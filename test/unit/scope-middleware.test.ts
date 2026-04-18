import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../src/router';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('scope middleware — query param fallback', () => {
  let testEnv: TestEnv;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
  });

  it('reads X-Project-Id header when present', async () => {
    const res = await app.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'from-header',
          'X-User-Id': 'u-from-header',
        },
        body: JSON.stringify({ id: 'sess-header' }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { project_id: string; user_id: string };
    expect(row.project_id).toBe('from-header');
    expect(row.user_id).toBe('u-from-header');
  });

  it('falls back to ?project_id= and ?user_id= query params', async () => {
    const res = await app.request(
      '/api/v1/sessions?project_id=from-query&user_id=u-from-query',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'sess-query' }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { project_id: string; user_id: string };
    expect(row.project_id).toBe('from-query');
    expect(row.user_id).toBe('u-from-query');
  });

  it('header wins over query param when both are present', async () => {
    // Distinct ids so we don't collide with the module-level seen-id cache
    // in the scope middlewares (existing test-isolation quirk; in prod the
    // DB row from that cache still exists, in tests clearAllTables wipes
    // the row but not the cache).
    const res = await app.request(
      '/api/v1/sessions?project_id=q-proj-both&user_id=q-user-both',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'h-proj-both',
          'X-User-Id': 'h-user-both',
        },
        body: JSON.stringify({ id: 'sess-both' }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { project_id: string; user_id: string };
    expect(row.project_id).toBe('h-proj-both');
    expect(row.user_id).toBe('h-user-both');
  });

  it('defaults to "default" when neither header nor query is provided', async () => {
    const res = await app.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'sess-default' }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { project_id: string; user_id: string };
    expect(row.project_id).toBe('default');
    expect(row.user_id).toBe('default');
  });
});
