import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ShortTermMemory } from '../../src/memory/short-term';
import { LongTermMemory } from '../../src/memory/long-term';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('Project Scoping', () => {
  let testEnv: TestEnv;
  const PROJECT_A = 'project-alpha';
  const PROJECT_B = 'project-beta';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_A);
    await seedProject(env.DB, PROJECT_B);
  });

  // -------------------------------------------------------------------------
  // Session isolation
  // -------------------------------------------------------------------------

  describe('session isolation', () => {
    it('Project A and B each only see their own sessions', async () => {
      const stmA = new ShortTermMemory(testEnv, PROJECT_A, 'default');
      const stmB = new ShortTermMemory(testEnv, PROJECT_B, 'default');

      await stmA.createSession('sess-a1');
      await stmA.createSession('sess-a2');
      await stmB.createSession('sess-b1');

      const sessionsA = await stmA.listSessions();
      const sessionsB = await stmB.listSessions();

      expect(sessionsA).toHaveLength(2);
      expect(sessionsB).toHaveLength(1);

      const idsA = sessionsA.map((s) => s.id);
      const idsB = sessionsB.map((s) => s.id);

      expect(idsA).toContain('sess-a1');
      expect(idsA).toContain('sess-a2');
      expect(idsA).not.toContain('sess-b1');

      expect(idsB).toContain('sess-b1');
      expect(idsB).not.toContain('sess-a1');
    });
  });

  // -------------------------------------------------------------------------
  // Entity isolation
  // -------------------------------------------------------------------------

  describe('entity isolation', () => {
    it('Project A creates entity - Project B cannot see it via getEntity', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT_A, 'default');
      const ltmB = new LongTermMemory(testEnv, PROJECT_B, 'default');

      const entity = await ltmA.addEntity({
        name: 'SecretEntity',
        entity_type: 'CUSTOM',
        description: 'Only for project A',
      });

      // Project A can see it
      const fromA = await ltmA.getEntity(entity.id);
      expect(fromA).not.toBeNull();
      expect(fromA!.name).toBe('SecretEntity');

      // Project B cannot see it
      const fromB = await ltmB.getEntity(entity.id);
      expect(fromB).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Preference isolation
  // -------------------------------------------------------------------------

  describe('preference isolation', () => {
    it('preferences are scoped to project', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT_A, 'default');
      const ltmB = new LongTermMemory(testEnv, PROJECT_B, 'default');

      await ltmA.addPreference({
        category: 'style',
        preference: 'Use dark mode',
      });

      const prefsA = await ltmA.listPreferences();
      const prefsB = await ltmB.listPreferences();

      expect(prefsA).toHaveLength(1);
      expect(prefsB).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Fact isolation
  // -------------------------------------------------------------------------

  describe('fact isolation', () => {
    it('facts are scoped to project', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT_A, 'default');
      const ltmB = new LongTermMemory(testEnv, PROJECT_B, 'default');

      await ltmA.addFact({
        subject: 'Sky',
        predicate: 'is',
        object: 'blue',
      });

      const factsA = await ltmA.listFacts();
      const factsB = await ltmB.listFacts();

      expect(factsA).toHaveLength(1);
      expect(factsB).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Global cascade
  // -------------------------------------------------------------------------

  describe('global cascade via cascading search', () => {
    it('global entity is visible when searching from any project', async () => {
      // Insert a global entity directly
      await env.DB.prepare(
        "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at, vector_id) VALUES ('global-ent', 'global', 'GlobalCorp', 'ORGANIZATION', '{}', datetime('now'), datetime('now'), 'global-ent')"
      ).run();

      // Insert a vector for it in the global namespace
      const { getEmbedding } = await import('../../src/services/embeddings');
      const embedding = await getEmbedding('GlobalCorp ORGANIZATION', testEnv.AI);

      const { vectorInsert } = await import('../../src/services/vectorize');
      await vectorInsert(
        testEnv.VEC_ENTITIES,
        'global-ent',
        embedding,
        'global',
        { name: 'GlobalCorp', entity_type: 'ORGANIZATION' }
      );

      // Search from Project A - should find the global entity
      const ltmA = new LongTermMemory(testEnv, PROJECT_A, 'default');
      const results = await ltmA.searchEntities('GlobalCorp');

      // The cascading search queries both project and global namespaces
      // Since we only have a global vector, it should appear
      expect(Array.isArray(results)).toBe(true);
      // With mock Vectorize, we should find the global entity
      const globalResult = results.find((r) => r.id === 'global-ent');
      expect(globalResult).toBeTruthy();
    });

    it('project results score higher than global results (project boost +0.1)', async () => {
      // Insert the same entity in both project and global
      const { getEmbedding } = await import('../../src/services/embeddings');
      const { vectorInsert } = await import('../../src/services/vectorize');

      const embedding = await getEmbedding('TestEntity CUSTOM', testEnv.AI);

      // Project entity
      await env.DB.prepare(
        "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at, vector_id) VALUES ('proj-ent', ?, 'TestEntity', 'CUSTOM', '{}', datetime('now'), datetime('now'), 'proj-ent')"
      )
        .bind(PROJECT_A)
        .run();
      await vectorInsert(
        testEnv.VEC_ENTITIES,
        'proj-ent',
        embedding,
        PROJECT_A,
        { name: 'TestEntity' }
      );

      // Global entity with same embedding
      await env.DB.prepare(
        "INSERT INTO entities (id, project_id, name, entity_type, metadata, created_at, updated_at, vector_id) VALUES ('glob-ent', 'global', 'TestEntity', 'CUSTOM', '{}', datetime('now'), datetime('now'), 'glob-ent')"
      ).run();
      await vectorInsert(
        testEnv.VEC_ENTITIES,
        'glob-ent',
        embedding,
        'global',
        { name: 'TestEntity' }
      );

      // Search from Project A
      const ltmA = new LongTermMemory(testEnv, PROJECT_A, 'default');
      const results = await ltmA.searchEntities('TestEntity');

      // Both should be present
      const projResult = results.find((r) => r.id === 'proj-ent');
      const globResult = results.find((r) => r.id === 'glob-ent');

      expect(projResult).toBeTruthy();
      expect(globResult).toBeTruthy();

      // Project result should have higher score due to +0.1 boost
      expect(projResult!.score).toBeGreaterThan(globResult!.score);
    });
  });
});
