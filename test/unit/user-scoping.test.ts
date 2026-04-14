import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ShortTermMemory } from '../../src/memory/short-term';
import { LongTermMemory } from '../../src/memory/long-term';
import { ProceduralMemory } from '../../src/memory/procedural';
import { promoteToGlobal, promote } from '../../src/memory/promotion';
import { getEmbedding } from '../../src/services/embeddings';
import { vectorInsert } from '../../src/services/vectorize';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
  seedUser,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('User Scoping', () => {
  let testEnv: TestEnv;
  const PROJECT = 'test-project';
  const USER_A = 'alice';
  const USER_B = 'bob';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT);
    await seedUser(env.DB, USER_A);
    await seedUser(env.DB, USER_B);
  });

  // -------------------------------------------------------------------------
  // User isolation within a project
  // -------------------------------------------------------------------------

  describe('user isolation', () => {
    it('user A cannot see user B sessions in the same project', async () => {
      const stmA = new ShortTermMemory(testEnv, PROJECT, USER_A);
      const stmB = new ShortTermMemory(testEnv, PROJECT, USER_B);

      await stmA.createSession('sess-a');
      await stmB.createSession('sess-b');

      const sessionsA = await stmA.listSessions();
      const sessionsB = await stmB.listSessions();

      expect(sessionsA).toHaveLength(1);
      expect(sessionsA[0]!.id).toBe('sess-a');
      expect(sessionsB).toHaveLength(1);
      expect(sessionsB[0]!.id).toBe('sess-b');
    });

    it('user A cannot see user B entities in the same project', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT, USER_A);
      const ltmB = new LongTermMemory(testEnv, PROJECT, USER_B);

      const entityA = await ltmA.addEntity({
        name: 'AliceEntity',
        entity_type: 'OBJECT',
        description: 'Owned by Alice',
      });

      // User B cannot retrieve user A's entity by ID
      const result = await ltmB.getEntity(entityA.id);
      expect(result).toBeNull();

      // User B can create their own entity with the same name (no dedup across users)
      const entityB = await ltmB.addEntity({
        name: 'AliceEntity',
        entity_type: 'OBJECT',
        description: 'Created by Bob independently',
      });
      expect(entityB.id).not.toBe(entityA.id);
    });

    it('user A cannot see user B preferences', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT, USER_A);
      const ltmB = new LongTermMemory(testEnv, PROJECT, USER_B);

      await ltmA.addPreference({
        category: 'editor',
        preference: 'Vim bindings',
      });

      const prefsB = await ltmB.listPreferences();
      expect(prefsB).toHaveLength(0);
    });

    it('user A cannot see user B facts', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT, USER_A);
      const ltmB = new LongTermMemory(testEnv, PROJECT, USER_B);

      await ltmA.addFact({
        subject: 'deploy',
        predicate: 'deadline',
        object: '2026-05-01',
      });

      const factsB = await ltmB.listFacts();
      expect(factsB).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Strict scope precedence for preferences
  // -------------------------------------------------------------------------

  describe('strict scope precedence', () => {
    it('narrower scope preference suppresses broader scope in same category', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT, USER_A);

      // Insert a global preference directly in D1 + Vectorize
      const globalPrefId = 'global-pref-1';
      await testEnv.DB.prepare(
        `INSERT INTO preferences (id, project_id, user_id, category, preference, created_at, updated_at, vector_id)
         VALUES (?, 'global', 'global', 'theme', 'Use light mode', datetime('now'), datetime('now'), ?)`
      )
        .bind(globalPrefId, globalPrefId)
        .run();

      const globalEmbed = await getEmbedding('theme: Use light mode', testEnv.AI);
      await vectorInsert(testEnv.VEC_PREFERENCES, globalPrefId, globalEmbed, 'global', {
        category: 'theme',
      });

      // Insert a project+user preference via the memory class
      const userPref = await ltmA.addPreference({
        category: 'theme',
        preference: 'Use dark mode',
      });

      // Search should return ONLY the narrower scope preference
      const results = await ltmA.searchPreferences('theme preferences', 10);

      // Filter to just theme-related results
      const themeResults = results.filter((r) => {
        return r.id === userPref.id || r.id === globalPrefId;
      });

      // The user-specific preference should be present
      expect(themeResults.some((r) => r.id === userPref.id)).toBe(true);

      // The global preference should be suppressed (strict scope precedence)
      expect(themeResults.some((r) => r.id === globalPrefId)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Default user backward compatibility
  // -------------------------------------------------------------------------

  describe('default user backward compatibility', () => {
    it('userId defaults to "default" and works like pre-migration behavior', async () => {
      // Using 'default' userId (the default when no X-User-Id header is sent)
      const stm = new ShortTermMemory(testEnv, PROJECT, 'default');
      const session = await stm.createSession('default-session');
      expect(session.user_id).toBe('default');

      const ltm = new LongTermMemory(testEnv, PROJECT, 'default');
      const entity = await ltm.addEntity({
        name: 'DefaultEntity',
        entity_type: 'OBJECT',
      });
      expect(entity.user_id).toBe('default');
    });
  });

  // -------------------------------------------------------------------------
  // Promotion to user scope
  // -------------------------------------------------------------------------

  describe('promote to user scope', () => {
    it('entity promoted to user scope is visible from another project', async () => {
      const PROJECT_2 = 'other-project';
      await seedProject(env.DB, PROJECT_2);

      // Create entity in project+user scope
      const ltm1 = new LongTermMemory(testEnv, PROJECT, USER_A);
      const entity = await ltm1.addEntity({
        name: 'SharedTool',
        entity_type: 'OBJECT',
        description: 'A tool Alice uses everywhere',
      });

      // Promote to user scope
      const result = await promote(
        testEnv,
        PROJECT,
        USER_A,
        'entity',
        entity.id,
        'Useful across all my projects',
        'user'
      );
      expect(result.promotedId).toBeDefined();

      // Verify the promoted row has project_id='global', user_id=USER_A
      const promoted = await testEnv.DB.prepare(
        'SELECT * FROM entities WHERE id = ?'
      )
        .bind(result.promotedId)
        .first();

      expect(promoted).not.toBeNull();
      expect(promoted!.project_id).toBe('global');
      expect(promoted!.user_id).toBe(USER_A);

      // Original still exists
      const original = await ltm1.getEntity(entity.id);
      expect(original).not.toBeNull();
    });

    it('entity promoted to global gets user_id=global', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT, USER_A);
      const entity = await ltm.addEntity({
        name: 'GlobalTool',
        entity_type: 'OBJECT',
      });

      const result = await promoteToGlobal(
        testEnv,
        PROJECT,
        USER_A,
        'entity',
        entity.id,
        'Everyone should know about this'
      );

      const promoted = await testEnv.DB.prepare(
        'SELECT * FROM entities WHERE id = ?'
      )
        .bind(result.globalId)
        .first();

      expect(promoted!.project_id).toBe('global');
      expect(promoted!.user_id).toBe('global');
    });

    it('promotion audit log includes source_user_id', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT, USER_A);
      const entity = await ltm.addEntity({
        name: 'AuditTest',
        entity_type: 'OBJECT',
      });

      await promoteToGlobal(
        testEnv,
        PROJECT,
        USER_A,
        'entity',
        entity.id,
        'Testing audit'
      );

      const log = await testEnv.DB.prepare(
        'SELECT * FROM promotion_log ORDER BY promoted_at DESC LIMIT 1'
      ).first();

      expect(log).not.toBeNull();
      expect(log!.source_project_id).toBe(PROJECT);
      expect(log!.source_user_id).toBe(USER_A);
    });
  });
});
