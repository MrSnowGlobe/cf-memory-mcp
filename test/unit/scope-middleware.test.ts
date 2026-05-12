import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../src/router';
import { mintConnectToken } from '../../src/auth/connect-token';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
  seedUser,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('scope middleware — resolution', () => {
  let testEnv: TestEnv;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
  });

  it('reads X-Project-Id header when present', async () => {
    await seedProject(env.DB, 'from-header');
    await seedUser(env.DB, 'u-from-header');
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

  it('allows ?project_id= and ?user_id= query params on GET requests', async () => {
    await seedProject(env.DB, 'from-query');
    await seedUser(env.DB, 'u-from-query');
    // Seed one session via header path so the GET has something to list.
    await app.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'from-query',
          'X-User-Id': 'u-from-query',
        },
        body: JSON.stringify({ id: 'sess-qp-readable' }),
      },
      testEnv
    );

    const res = await app.request(
      '/api/v1/sessions?project_id=from-query&user_id=u-from-query',
      {
        method: 'GET',
        headers: { Authorization: 'Bearer test-token' },
      },
      testEnv
    );
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<{ id: string; project_id: string }>;
    expect(sessions.some((s) => s.id === 'sess-qp-readable')).toBe(true);
  });

  it('rejects ?project_id= query-param fallback on POST', async () => {
    const res = await app.request(
      '/api/v1/sessions?project_id=q-proj-write&user_id=q-user-write',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'sess-qp-write' }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it('rejects conflicting X-Project-Id header and project_id query param', async () => {
    const res = await app.request(
      '/api/v1/sessions?project_id=q-proj-conflict&user_id=u-default',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'h-proj-conflict',
          'X-User-Id': 'u-default',
        },
        body: JSON.stringify({ id: 'sess-conflict' }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it('accepts matching header and query-param values', async () => {
    await seedProject(env.DB, 'same-id');
    await seedUser(env.DB, 'same-user');
    const res = await app.request(
      '/api/v1/sessions?project_id=same-id&user_id=same-user',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'same-id',
          'X-User-Id': 'same-user',
        },
        body: JSON.stringify({ id: 'sess-match' }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
  });

  it('rejects malformed project_id charset', async () => {
    const res = await app.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'has:colon',
          'X-User-Id': 'default',
        },
        body: JSON.stringify({ id: 'sess-bad' }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it('rejects malformed user_id charset', async () => {
    const res = await app.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'default',
          'X-User-Id': 'has space',
        },
        body: JSON.stringify({ id: 'sess-bad' }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it('rejects scope ids longer than 64 chars', async () => {
    const res = await app.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'a'.repeat(65),
          'X-User-Id': 'default',
        },
        body: JSON.stringify({ id: 'sess-long' }),
      },
      testEnv
    );
    expect(res.status).toBe(400);
  });

  it('auto-creates the project on first write with an unregistered ID', async () => {
    const res = await app.request(
      '/api/v1/sessions',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'Content-Type': 'application/json',
          'X-Project-Id': 'auto-created-xyz',
          'X-User-Id': 'default',
        },
        body: JSON.stringify({ id: 'sess-auto' }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
    const row = (await res.json()) as { project_id: string };
    expect(row.project_id).toBe('auto-created-xyz');
    const projectRow = await testEnv.DB.prepare(
      'SELECT id FROM projects WHERE id = ?'
    )
      .bind('auto-created-xyz')
      .first<{ id: string }>();
    expect(projectRow?.id).toBe('auto-created-xyz');
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

describe('scope middleware — ws_token', () => {
  let testEnv: TestEnv;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
  });

  it('mints a token via POST /api/v1/events/token', async () => {
    await seedProject(env.DB, 'proj-mint');
    await seedUser(env.DB, 'user-mint');
    const res = await app.request(
      '/api/v1/events/token',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'X-Project-Id': 'proj-mint',
          'X-User-Id': 'user-mint',
        },
      },
      testEnv
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expires_in: number };
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(5);
    expect(body.expires_in).toBeGreaterThan(0);
  });

  it('rejects events WS upgrade with an invalid ws_token', async () => {
    const res = await app.request(
      '/api/v1/events?ws_token=not-a-real-token',
      {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer test-token',
          'Upgrade': 'websocket',
        },
      },
      testEnv
    );
    expect(res.status).toBe(401);
  });

  it('verifyConnectToken round-trips a minted token', async () => {
    const { verifyConnectToken } = await import('../../src/auth/connect-token');
    const { token } = await mintConnectToken(testEnv, 'rt-proj', 'rt-user');
    const claims = await verifyConnectToken(testEnv, token);
    expect(claims).not.toBeNull();
    expect(claims!.projectId).toBe('rt-proj');
    expect(claims!.userId).toBe('rt-user');
  });

  it('rejects a token whose signature has been tampered with', async () => {
    const { verifyConnectToken } = await import('../../src/auth/connect-token');
    const { token } = await mintConnectToken(testEnv, 'rt-proj', 'rt-user');
    // Flip the last hex char of the signature.
    const tampered =
      token.slice(0, -1) + (token.slice(-1) === '0' ? '1' : '0');
    const claims = await verifyConnectToken(testEnv, tampered);
    expect(claims).toBeNull();
  });

  it('rejects a token signed under a different AUTH_TOKEN', async () => {
    const { verifyConnectToken } = await import('../../src/auth/connect-token');
    const { token } = await mintConnectToken(testEnv, 'rt-proj', 'rt-user');
    const claims = await verifyConnectToken(
      { ...testEnv, AUTH_TOKEN: 'rotated-token' },
      token
    );
    expect(claims).toBeNull();
  });
});
