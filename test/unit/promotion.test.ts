import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { LongTermMemory } from '../../src/memory/long-term';
import { promoteToGlobal } from '../../src/memory/promotion';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';
import type { EntityRow, PreferenceRow, FactRow, PromotionLogRow } from '../../src/types';

describe('promoteToGlobal', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-promote-proj';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  // -------------------------------------------------------------------------
  // Entity promotion
  // -------------------------------------------------------------------------

  describe('entity promotion', () => {
    it('creates a global copy with project_id = global', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const entity = await ltm.addEntity({
        name: 'PromoteMe',
        entity_type: 'PERSON',
        description: 'A promotable entity',
      });

      const result = await promoteToGlobal(
        testEnv,
        PROJECT_ID,
        'default',
        'entity',
        entity.id,
        'Useful globally'
      );

      expect(result.globalId).toBeTruthy();

      // Verify global copy exists in D1
      const globalEntity = await env.DB.prepare(
        "SELECT * FROM entities WHERE id = ? AND project_id = 'global'"
      )
        .bind(result.globalId)
        .first<EntityRow>();

      expect(globalEntity).not.toBeNull();
      expect(globalEntity!.name).toBe('PromoteMe');
      expect(globalEntity!.entity_type).toBe('PERSON');
      expect(globalEntity!.promoted_from).toBe(PROJECT_ID);
    });

    it('original entity still exists in project scope', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const entity = await ltm.addEntity({
        name: 'StillHere',
        entity_type: 'ORGANIZATION',
      });

      await promoteToGlobal(
        testEnv,
        PROJECT_ID,
        'default',
        'entity',
        entity.id,
        'Global promotion'
      );

      // Original should still be in the project
      const original = await ltm.getEntity(entity.id);
      expect(original).not.toBeNull();
      expect(original!.project_id).toBe(PROJECT_ID);
    });

    it('writes audit log entry', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const entity = await ltm.addEntity({
        name: 'Audited',
        entity_type: 'PERSON',
      });

      const result = await promoteToGlobal(
        testEnv,
        PROJECT_ID,
        'default',
        'entity',
        entity.id,
        'Audit test reason'
      );

      const log = await env.DB.prepare(
        'SELECT * FROM promotion_log WHERE source_record_id = ?'
      )
        .bind(entity.id)
        .first<PromotionLogRow>();

      expect(log).not.toBeNull();
      expect(log!.source_project_id).toBe(PROJECT_ID);
      expect(log!.target_type).toBe('entity');
      expect(log!.global_record_id).toBe(result.globalId);
      expect(log!.reason).toBe('Audit test reason');
    });

    it('throws error for non-existent entity', async () => {
      await expect(
        promoteToGlobal(
          testEnv,
          PROJECT_ID,
          'default',
          'entity',
          'nonexistent-id',
          'Should fail'
        )
      ).rejects.toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // Preference promotion
  // -------------------------------------------------------------------------

  describe('preference promotion', () => {
    it('creates a global copy of the preference', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const pref = await ltm.addPreference({
        category: 'style',
        preference: 'Dark theme',
        context: 'IDE settings',
      });

      const result = await promoteToGlobal(
        testEnv,
        PROJECT_ID,
        'default',
        'preference',
        pref.id,
        'Universal preference'
      );

      const globalPref = await env.DB.prepare(
        "SELECT * FROM preferences WHERE id = ? AND project_id = 'global'"
      )
        .bind(result.globalId)
        .first<PreferenceRow>();

      expect(globalPref).not.toBeNull();
      expect(globalPref!.category).toBe('style');
      expect(globalPref!.preference).toBe('Dark theme');
      expect(globalPref!.promoted_from).toBe(PROJECT_ID);
    });

    it('throws for non-existent preference', async () => {
      await expect(
        promoteToGlobal(
          testEnv,
          PROJECT_ID,
          'default',
          'preference',
          'no-such-pref',
          'Fail'
        )
      ).rejects.toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // Fact promotion
  // -------------------------------------------------------------------------

  describe('fact promotion', () => {
    it('creates a global copy of the fact', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const fact = await ltm.addFact({
        subject: 'Water',
        predicate: 'boils at',
        object: '100C',
        source: 'physics',
      });

      const result = await promoteToGlobal(
        testEnv,
        PROJECT_ID,
        'default',
        'fact',
        fact.id,
        'Universal fact'
      );

      const globalFact = await env.DB.prepare(
        "SELECT * FROM facts WHERE id = ? AND project_id = 'global'"
      )
        .bind(result.globalId)
        .first<FactRow>();

      expect(globalFact).not.toBeNull();
      expect(globalFact!.subject).toBe('Water');
      expect(globalFact!.predicate).toBe('boils at');
      expect(globalFact!.object).toBe('100C');
      expect(globalFact!.promoted_from).toBe(PROJECT_ID);
    });

    it('throws for non-existent fact', async () => {
      await expect(
        promoteToGlobal(
          testEnv,
          PROJECT_ID,
          'default',
          'fact',
          'no-such-fact',
          'Fail'
        )
      ).rejects.toThrow(/not found/);
    });
  });
});
