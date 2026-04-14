import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { fuzzyMatch, resolveEntity } from '../../src/services/resolution';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('fuzzyMatch', () => {
  it('returns 1.0 for exact match', () => {
    expect(fuzzyMatch('hello', 'hello')).toBe(1.0);
  });

  it('returns 1.0 for empty strings', () => {
    expect(fuzzyMatch('', '')).toBe(1.0);
  });

  it('is case insensitive', () => {
    expect(fuzzyMatch('Hello', 'hello')).toBe(1.0);
    expect(fuzzyMatch('WORLD', 'world')).toBe(1.0);
  });

  it('returns high score (>0.85) for similar strings', () => {
    const score = fuzzyMatch('JavaScript', 'JavaScrip');
    expect(score).toBeGreaterThan(0.85);
  });

  it('returns low score (<0.5) for dissimilar strings', () => {
    const score = fuzzyMatch('cat', 'elephant');
    expect(score).toBeLessThan(0.5);
  });

  it('handles single-character strings', () => {
    expect(fuzzyMatch('a', 'a')).toBe(1.0);
    expect(fuzzyMatch('a', 'b')).toBe(0.0);
  });

  it('handles strings of very different lengths', () => {
    const score = fuzzyMatch('a', 'abcdefghij');
    expect(score).toBeLessThan(0.5);
  });
});

describe('resolveEntity', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-resolve-proj';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  it('returns exact match by name and type', async () => {
    // Insert an entity directly
    await env.DB.prepare(
      "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at) VALUES ('e1', ?, 'Alice', 'PERSON', '{}', datetime('now'), datetime('now'))"
    )
      .bind(PROJECT_ID)
      .run();

    const resolved = await resolveEntity(testEnv, 'Alice', 'PERSON', PROJECT_ID, 'default');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('Alice');
  });

  it('returns exact match case-insensitively', async () => {
    await env.DB.prepare(
      "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at) VALUES ('e2', ?, 'Bob Smith', 'PERSON', '{}', datetime('now'), datetime('now'))"
    )
      .bind(PROJECT_ID)
      .run();

    const resolved = await resolveEntity(testEnv, 'bob smith', 'PERSON', PROJECT_ID, 'default');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('Bob Smith');
  });

  it('returns null when no match exists', async () => {
    const resolved = await resolveEntity(testEnv, 'Unknown', 'PERSON', PROJECT_ID, 'default');
    expect(resolved).toBeNull();
  });

  it('returns fuzzy match for similar names (>= 0.85 threshold)', async () => {
    await env.DB.prepare(
      "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at) VALUES ('e3', ?, 'JavaScript', 'CUSTOM', '{}', datetime('now'), datetime('now'))"
    )
      .bind(PROJECT_ID)
      .run();

    // "JavaScrip" is very close to "JavaScript"
    const resolved = await resolveEntity(testEnv, 'JavaScrip', 'CUSTOM', PROJECT_ID, 'default');
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('JavaScript');
  });

  it('does not fuzzy match if different entity_type', async () => {
    await env.DB.prepare(
      "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at) VALUES ('e4', ?, 'JavaScript', 'CUSTOM', '{}', datetime('now'), datetime('now'))"
    )
      .bind(PROJECT_ID)
      .run();

    // Searching for PERSON type, not CUSTOM
    const resolved = await resolveEntity(testEnv, 'JavaScrip', 'PERSON', PROJECT_ID, 'default');
    // Should not match because entity_type is different
    expect(resolved).toBeNull();
  });

  it('prefers project-scoped matches over global', async () => {
    // Insert same entity in both global and project
    await env.DB.prepare(
      "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at) VALUES ('eg', 'global', 'MyEntity', 'CUSTOM', '{}', datetime('now'), datetime('now'))"
    ).run();
    await env.DB.prepare(
      "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at) VALUES ('ep', ?, 'MyEntity', 'CUSTOM', '{}', datetime('now'), datetime('now'))"
    )
      .bind(PROJECT_ID)
      .run();

    const resolved = await resolveEntity(testEnv, 'MyEntity', 'CUSTOM', PROJECT_ID, 'default');
    expect(resolved).not.toBeNull();
    // The exact match ORDER BY prefers project_id = PROJECT_ID (CASE 0) over global (CASE 1)
    expect(resolved!.project_id).toBe(PROJECT_ID);
  });
});
