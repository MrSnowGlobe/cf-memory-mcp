import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { LongTermMemory } from '../../src/memory/long-term';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('LongTermMemory', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-project-ltm';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  describe('addEntity', () => {
    it('creates an entity and returns an EntityRow', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const entity = await ltm.addEntity({
        name: 'Alice',
        entity_type: 'PERSON',
        description: 'A test user',
      });

      expect(entity.name).toBe('Alice');
      expect(entity.entity_type).toBe('PERSON');
      expect(entity.project_id).toBe(PROJECT_ID);
      expect(entity.description).toBe('A test user');
      expect(entity.id).toBeTruthy();
      expect(entity.vector_id).toBeTruthy();

      // Verify in D1
      const row = await env.DB.prepare('SELECT * FROM entities WHERE id = ?')
        .bind(entity.id)
        .first();
      expect(row).not.toBeNull();
    });

    it('returns existing entity on exact name match (dedup via resolution)', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');

      const first = await ltm.addEntity({
        name: 'Alice',
        entity_type: 'PERSON',
      });

      const second = await ltm.addEntity({
        name: 'Alice',
        entity_type: 'PERSON',
      });

      // Should return the same entity
      expect(second.id).toBe(first.id);

      // Only one row in D1
      const count = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM entities WHERE name = 'Alice' AND project_id = ?"
      )
        .bind(PROJECT_ID)
        .first<{ cnt: number }>();
      expect(count!.cnt).toBe(1);
    });
  });

  describe('getEntity', () => {
    it('returns entity by ID', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const created = await ltm.addEntity({
        name: 'Bob',
        entity_type: 'PERSON',
      });

      const fetched = await ltm.getEntity(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('Bob');
    });

    it('returns null for entity in a different project', async () => {
      const otherProject = 'other-ltm-project';
      await seedProject(env.DB, otherProject);
      const otherLtm = new LongTermMemory(testEnv, otherProject, 'default');
      const entity = await otherLtm.addEntity({
        name: 'Charlie',
        entity_type: 'PERSON',
      });

      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const result = await ltm.getEntity(entity.id);
      expect(result).toBeNull();
    });
  });

  describe('updateEntity', () => {
    it('updates fields and returns updated row', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const entity = await ltm.addEntity({
        name: 'Dave',
        entity_type: 'PERSON',
        description: 'Original desc',
      });

      const updated = await ltm.updateEntity(entity.id, {
        description: 'Updated desc',
      });

      expect(updated.description).toBe('Updated desc');
      expect(updated.name).toBe('Dave'); // unchanged
    });

    it('throws for non-existent entity', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');

      await expect(
        ltm.updateEntity('no-such-id', { name: 'New Name' })
      ).rejects.toThrow(/not found/);
    });
  });

  describe('deleteEntity', () => {
    it('removes entity from D1', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const entity = await ltm.addEntity({
        name: 'Eve',
        entity_type: 'PERSON',
      });

      await ltm.deleteEntity(entity.id);

      const result = await ltm.getEntity(entity.id);
      expect(result).toBeNull();
    });

    it('silently ignores deleting non-existent entity', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      // Should not throw
      await ltm.deleteEntity('non-existent-id');
    });
  });

  describe('searchEntities', () => {
    it('completes without errors', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      await ltm.addEntity({
        name: 'TestSearchEntity',
        entity_type: 'ORGANIZATION',
        description: 'A company for testing',
      });

      const results = await ltm.searchEntities('company');
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Relations
  // -------------------------------------------------------------------------

  describe('addRelation', () => {
    it('creates a relation between two entities', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const alice = await ltm.addEntity({
        name: 'Alice R',
        entity_type: 'PERSON',
      });
      const bob = await ltm.addEntity({
        name: 'Bob R',
        entity_type: 'PERSON',
      });

      const relation = await ltm.addRelation(
        alice.id,
        bob.id,
        'KNOWS'
      );

      expect(relation.source_entity_id).toBe(alice.id);
      expect(relation.target_entity_id).toBe(bob.id);
      expect(relation.relation_type).toBe('KNOWS');
    });

    it('returns existing relation on duplicate insert', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const a = await ltm.addEntity({ name: 'A', entity_type: 'PERSON' });
      const b = await ltm.addEntity({ name: 'B', entity_type: 'PERSON' });

      const first = await ltm.addRelation(a.id, b.id, 'WORKS_WITH');
      const second = await ltm.addRelation(a.id, b.id, 'WORKS_WITH');

      expect(second.source_entity_id).toBe(first.source_entity_id);
      expect(second.target_entity_id).toBe(first.target_entity_id);
      expect(second.relation_type).toBe(first.relation_type);
    });
  });

  describe('getRelations', () => {
    it('returns relations for an entity', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const a = await ltm.addEntity({ name: 'X', entity_type: 'PERSON' });
      const b = await ltm.addEntity({ name: 'Y', entity_type: 'PERSON' });
      const c = await ltm.addEntity({ name: 'Z', entity_type: 'PERSON' });

      await ltm.addRelation(a.id, b.id, 'KNOWS');
      await ltm.addRelation(c.id, a.id, 'MANAGES');

      const relations = await ltm.getRelations(a.id);
      expect(relations).toHaveLength(2);
    });

    it('returns empty array when entity has no relations', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const entity = await ltm.addEntity({
        name: 'Lonely',
        entity_type: 'PERSON',
      });

      const relations = await ltm.getRelations(entity.id);
      expect(relations).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  describe('addPreference', () => {
    it('creates preference with correct fields', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const pref = await ltm.addPreference({
        category: 'coding',
        preference: 'TypeScript over JavaScript',
        context: 'backend services',
        confidence: 0.9,
      });

      expect(pref.category).toBe('coding');
      expect(pref.preference).toBe('TypeScript over JavaScript');
      expect(pref.context).toBe('backend services');
      expect(pref.confidence).toBe(0.9);
      expect(pref.project_id).toBe(PROJECT_ID);
    });
  });

  describe('listPreferences', () => {
    it('filters by category', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      await ltm.addPreference({
        category: 'coding',
        preference: 'Prefer Vitest',
      });
      await ltm.addPreference({
        category: 'coding',
        preference: 'Use strict mode',
      });
      await ltm.addPreference({
        category: 'design',
        preference: 'Dark theme',
      });

      const codingPrefs = await ltm.listPreferences('coding');
      expect(codingPrefs).toHaveLength(2);

      const designPrefs = await ltm.listPreferences('design');
      expect(designPrefs).toHaveLength(1);
    });

    it('returns all preferences when no category is specified', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      await ltm.addPreference({
        category: 'coding',
        preference: 'Pref 1',
      });
      await ltm.addPreference({
        category: 'design',
        preference: 'Pref 2',
      });

      const all = await ltm.listPreferences();
      expect(all).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------

  describe('addFact', () => {
    it('creates a fact with correct fields', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const fact = await ltm.addFact({
        subject: 'Earth',
        predicate: 'orbits',
        object: 'Sun',
        source: 'astronomy',
      });

      expect(fact.subject).toBe('Earth');
      expect(fact.predicate).toBe('orbits');
      expect(fact.object).toBe('Sun');
      expect(fact.source).toBe('astronomy');
      expect(fact.project_id).toBe(PROJECT_ID);
    });
  });

  describe('listFacts', () => {
    it('filters by subject and predicate', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      await ltm.addFact({
        subject: 'Earth',
        predicate: 'has',
        object: 'Moon',
      });
      await ltm.addFact({
        subject: 'Earth',
        predicate: 'orbits',
        object: 'Sun',
      });
      await ltm.addFact({
        subject: 'Mars',
        predicate: 'has',
        object: 'Phobos',
      });

      const earthFacts = await ltm.listFacts({ subject: 'Earth' });
      expect(earthFacts).toHaveLength(2);

      const hasFacts = await ltm.listFacts({ predicate: 'has' });
      expect(hasFacts).toHaveLength(2);

      const earthOrbits = await ltm.listFacts({
        subject: 'Earth',
        predicate: 'orbits',
      });
      expect(earthOrbits).toHaveLength(1);
    });

    it('excludes expired facts', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      await ltm.addFact({
        subject: 'Test',
        predicate: 'is',
        object: 'valid',
      });
      const expiredFact = await ltm.addFact({
        subject: 'Test',
        predicate: 'was',
        object: 'expired',
        valid_until: '2020-01-01T00:00:00.000Z', // far in the past
      });

      const facts = await ltm.listFacts({ subject: 'Test' });
      // Should only contain the valid fact, not the expired one
      expect(facts).toHaveLength(1);
      expect(facts[0]!.predicate).toBe('is');
    });
  });

  describe('invalidateFact', () => {
    it('sets valid_until on a fact', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const fact = await ltm.addFact({
        subject: 'Price',
        predicate: 'is',
        object: '$10',
      });

      const expiry = '2025-01-01T00:00:00.000Z';
      await ltm.invalidateFact(fact.id, expiry);

      const row = await env.DB.prepare('SELECT * FROM facts WHERE id = ?')
        .bind(fact.id)
        .first<{ valid_until: string }>();
      expect(row!.valid_until).toBe(expiry);
    });

    it('uses current time when no validUntil provided', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const fact = await ltm.addFact({
        subject: 'Status',
        predicate: 'is',
        object: 'active',
      });

      await ltm.invalidateFact(fact.id);

      const row = await env.DB.prepare('SELECT * FROM facts WHERE id = ?')
        .bind(fact.id)
        .first<{ valid_until: string }>();
      expect(row!.valid_until).toBeTruthy();
    });
  });
});
