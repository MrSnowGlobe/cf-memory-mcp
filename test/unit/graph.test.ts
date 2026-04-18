import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { LongTermMemory } from '../../src/memory/long-term';
import { traverseRelations } from '../../src/services/graph';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';
import type { EntityRow } from '../../src/types';

describe('graph traversal', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-project-graph';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  interface SeededGraph {
    alice: EntityRow;
    bob: EntityRow;
    carol: EntityRow;
    dave: EntityRow;
    eve: EntityRow;
  }

  /**
   * Builds a chain Alice -> Bob -> Carol -> Dave with a side branch
   * Bob -> Eve. Returns the entities by name.
   */
  async function seedGraph(): Promise<SeededGraph> {
    const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
    const alice = await ltm.addEntity({ name: 'Alice', entity_type: 'PERSON' });
    const bob = await ltm.addEntity({ name: 'Bob', entity_type: 'PERSON' });
    const carol = await ltm.addEntity({ name: 'Carol', entity_type: 'PERSON' });
    const dave = await ltm.addEntity({ name: 'Dave', entity_type: 'PERSON' });
    const eve = await ltm.addEntity({ name: 'Eve', entity_type: 'PERSON' });

    await ltm.addRelation(alice.id, bob.id, 'knows');
    await ltm.addRelation(bob.id, carol.id, 'knows');
    await ltm.addRelation(carol.id, dave.id, 'knows');
    await ltm.addRelation(bob.id, eve.id, 'works_with');

    return { alice, bob, carol, dave, eve };
  }

  describe('addRelation with strength', () => {
    it('persists relation_strength when provided', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const a = await ltm.addEntity({ name: 'A', entity_type: 'PERSON' });
      const b = await ltm.addEntity({ name: 'B', entity_type: 'PERSON' });

      const rel = await ltm.addRelation(a.id, b.id, 'knows', undefined, 0.42);
      expect(rel.relation_strength).toBeCloseTo(0.42);
    });

    it('defaults strength to 1.0', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const a = await ltm.addEntity({ name: 'A', entity_type: 'PERSON' });
      const b = await ltm.addEntity({ name: 'B', entity_type: 'PERSON' });

      const rel = await ltm.addRelation(a.id, b.id, 'knows');
      expect(rel.relation_strength).toBe(1.0);
    });

    it('updates strength on conflict', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const a = await ltm.addEntity({ name: 'A', entity_type: 'PERSON' });
      const b = await ltm.addEntity({ name: 'B', entity_type: 'PERSON' });

      await ltm.addRelation(a.id, b.id, 'knows', undefined, 0.3);
      const updated = await ltm.addRelation(a.id, b.id, 'knows', undefined, 0.9);
      expect(updated.relation_strength).toBeCloseTo(0.9);
    });
  });

  describe('traverseRelations', () => {
    it('returns 1-hop neighbors at depth 1', async () => {
      const { alice, bob } = await seedGraph();
      const neighbors = await traverseRelations(testEnv, alice.id, PROJECT_ID, 'default', {
        maxDepth: 1,
      });
      const names = neighbors.map((n) => n.name).sort();
      expect(names).toEqual(['Bob']);
      expect(neighbors[0]!.id).toBe(bob.id);
      expect(neighbors[0]!.hop_distance).toBe(1);
    });

    it('returns 2-hop neighbors at depth 2', async () => {
      const { alice } = await seedGraph();
      const neighbors = await traverseRelations(testEnv, alice.id, PROJECT_ID, 'default', {
        maxDepth: 2,
      });
      const names = neighbors.map((n) => n.name).sort();
      // From Alice at depth 2 (both directions): Bob (1), Carol (2), Eve (2)
      expect(names).toEqual(['Bob', 'Carol', 'Eve']);
    });

    it('respects depth cap', async () => {
      const { alice } = await seedGraph();
      const neighbors = await traverseRelations(testEnv, alice.id, PROJECT_ID, 'default', {
        maxDepth: 3,
      });
      // Adds Dave (depth 3) on top of the depth-2 set
      const names = neighbors.map((n) => n.name).sort();
      expect(names).toEqual(['Bob', 'Carol', 'Dave', 'Eve']);
    });

    it('reports MIN(depth) when an entity is reachable via multiple paths', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const a = await ltm.addEntity({ name: 'A', entity_type: 'PERSON' });
      const b = await ltm.addEntity({ name: 'B', entity_type: 'PERSON' });
      const c = await ltm.addEntity({ name: 'C', entity_type: 'PERSON' });
      // Two paths to C: A->C (1 hop) and A->B->C (2 hops)
      await ltm.addRelation(a.id, b.id, 'knows');
      await ltm.addRelation(a.id, c.id, 'knows');
      await ltm.addRelation(b.id, c.id, 'knows');

      const neighbors = await traverseRelations(testEnv, a.id, PROJECT_ID, 'default', {
        maxDepth: 3,
      });
      const cRow = neighbors.find((n) => n.id === c.id);
      expect(cRow?.hop_distance).toBe(1);
    });

    it('filters by relation_types', async () => {
      const { alice } = await seedGraph();
      const neighbors = await traverseRelations(testEnv, alice.id, PROJECT_ID, 'default', {
        maxDepth: 3,
        relationTypes: ['works_with'],
      });
      // No 'works_with' edges originate from Alice, so traversal stops immediately
      expect(neighbors).toEqual([]);
    });

    it('honors direction=out (only outgoing edges)', async () => {
      const { alice, bob } = await seedGraph();
      const neighbors = await traverseRelations(testEnv, bob.id, PROJECT_ID, 'default', {
        maxDepth: 1,
        direction: 'out',
      });
      // Bob's outgoing: knows->Carol, works_with->Eve. NOT Alice (incoming).
      const names = neighbors.map((n) => n.name).sort();
      expect(names).toEqual(['Carol', 'Eve']);
      expect(names).not.toContain('Alice');
      // Suppress unused-binding lint
      void alice;
    });

    it('honors direction=in (only incoming edges)', async () => {
      const { bob } = await seedGraph();
      const neighbors = await traverseRelations(testEnv, bob.id, PROJECT_ID, 'default', {
        maxDepth: 1,
        direction: 'in',
      });
      // Only Alice -> Bob
      const names = neighbors.map((n) => n.name);
      expect(names).toEqual(['Alice']);
    });

    it('respects limit', async () => {
      const { alice } = await seedGraph();
      const neighbors = await traverseRelations(testEnv, alice.id, PROJECT_ID, 'default', {
        maxDepth: 3,
        limit: 2,
      });
      expect(neighbors.length).toBe(2);
    });

    it('isolates by project scope', async () => {
      const ltmA = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const aliceA = await ltmA.addEntity({ name: 'AliceA', entity_type: 'PERSON' });
      const bobA = await ltmA.addEntity({ name: 'BobA', entity_type: 'PERSON' });
      await ltmA.addRelation(aliceA.id, bobA.id, 'knows');

      const OTHER = 'test-project-other';
      await seedProject(env.DB, OTHER);
      const ltmB = new LongTermMemory(testEnv, OTHER, 'default');
      const aliceB = await ltmB.addEntity({ name: 'AliceB', entity_type: 'PERSON' });
      const bobB = await ltmB.addEntity({ name: 'BobB', entity_type: 'PERSON' });
      await ltmB.addRelation(aliceB.id, bobB.id, 'knows');

      // Project A traversal sees only A's graph
      const neighbors = await traverseRelations(testEnv, aliceA.id, PROJECT_ID, 'default', {
        maxDepth: 2,
      });
      const names = neighbors.map((n) => n.name);
      expect(names).toContain('BobA');
      expect(names).not.toContain('BobB');
      expect(names).not.toContain('AliceB');
    });

    it('clamps maxDepth to hardMaxDepth', async () => {
      const { alice } = await seedGraph();
      // Asking for depth 99 should not error; clamps internally.
      const neighbors = await traverseRelations(testEnv, alice.id, PROJECT_ID, 'default', {
        maxDepth: 99,
      });
      expect(neighbors.length).toBeGreaterThan(0);
    });

    it('returns empty array for entity with no relations', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const lonely = await ltm.addEntity({ name: 'Lonely', entity_type: 'PERSON' });
      const neighbors = await traverseRelations(testEnv, lonely.id, PROJECT_ID, 'default');
      expect(neighbors).toEqual([]);
    });
  });

  describe('LongTermMemory.traverseRelations', () => {
    it('exposes traversal as a method', async () => {
      const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
      const { alice } = await seedGraph();
      const neighbors = await ltm.traverseRelations(alice.id, { maxDepth: 1 });
      expect(neighbors.map((n) => n.name)).toEqual(['Bob']);
    });
  });
});
