import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import app from '../../src/router';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('admin auth gate', () => {
  let testEnv: TestEnv;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
  });

  it('refuses admin route when X-Admin-Token is missing', async () => {
    const res = await app.request(
      '/api/v1/admin/migrate-namespaces',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token' },
      },
      testEnv
    );
    expect(res.status).toBe(401);
  });

  it('refuses admin route when X-Admin-Token is wrong', async () => {
    const res = await app.request(
      '/api/v1/admin/migrate-namespaces',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'X-Admin-Token': 'totally-wrong',
        },
      },
      testEnv
    );
    expect(res.status).toBe(403);
  });

  it('refuses admin route when ADMIN_TOKEN is unset on the deployment', async () => {
    const { ADMIN_TOKEN: _omit, ...envWithoutAdmin } = testEnv;
    void _omit;
    const res = await app.request(
      '/api/v1/admin/migrate-namespaces',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-token',
          'X-Admin-Token': 'anything',
        },
      },
      envWithoutAdmin as TestEnv
    );
    expect(res.status).toBe(503);
  });

  it('accepts admin route with the correct X-Admin-Token and records an audit row', async () => {
    await seedProject(env.DB, 'audit-target');
    const res = await app.request(
      '/api/v1/admin/projects/audit-target/purge?confirm=yes',
      {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer test-token',
          'X-Admin-Token': 'test-admin-token',
        },
      },
      testEnv
    );
    expect(res.status).toBe(200);

    const audit = await testEnv.DB.prepare(
      'SELECT route, method, target, status, outcome FROM admin_audit ORDER BY ts DESC LIMIT 1'
    ).first<{
      route: string;
      method: string;
      target: string;
      status: number;
      outcome: string;
    }>();
    expect(audit).not.toBeNull();
    expect(audit!.route).toBe('/api/v1/admin/projects/:id/purge');
    expect(audit!.method).toBe('DELETE');
    expect(audit!.target).toBe('audit-target');
    expect(audit!.status).toBe(200);
    expect(audit!.outcome).toBe('purged');
  });

  it('records a 400 audit row when confirm is missing', async () => {
    await seedProject(env.DB, 'audit-noconfirm');
    const res = await app.request(
      '/api/v1/admin/projects/audit-noconfirm/purge',
      {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer test-token',
          'X-Admin-Token': 'test-admin-token',
        },
      },
      testEnv
    );
    expect(res.status).toBe(400);

    const audit = await testEnv.DB.prepare(
      'SELECT outcome FROM admin_audit WHERE target = ? ORDER BY ts DESC LIMIT 1'
    )
      .bind('audit-noconfirm')
      .first<{ outcome: string }>();
    expect(audit?.outcome).toBe('missing-confirmation');
  });
});
