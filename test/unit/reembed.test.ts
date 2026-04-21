import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { reembedAllVectors } from '../../src/admin/reembed-vectors';
import { ShortTermMemory } from '../../src/memory/short-term';
import { LongTermMemory } from '../../src/memory/long-term';
import { ProceduralMemory } from '../../src/memory/procedural';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('reembedAllVectors', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-reembed';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  it('returns zeros on an empty database', async () => {
    const result = await reembedAllVectors(testEnv);
    expect(result.totalProcessed).toBe(0);
    expect(result.totalUpdated).toBe(0);
    expect(result.totalErrors).toBe(0);
    expect(result.tables.map((t) => t.table)).toEqual([
      'messages',
      'entities',
      'preferences',
      'facts',
      'reasoning_traces',
    ]);
  });

  it('re-embeds every vector across all tables and preserves IDs', async () => {
    // Seed representative data across all five tables.
    const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
    await stm.createSession('sess-reembed');
    const msg = await stm.addMessage('sess-reembed', 'user', 'hello world');

    const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
    const ent = await ltm.addEntity({
      name: 'TestEntity',
      entity_type: 'PERSON',
      description: 'description text',
    });
    const pref = await ltm.addPreference({
      category: 'testing',
      preference: 'use vitest',
    });
    const fact = await ltm.addFact({
      subject: 'Sky',
      predicate: 'is',
      object: 'blue',
    });

    const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
    const pending = await proc.startTrace({ task: 'in-flight task' });
    const done = await proc.startTrace({ task: 'finished task' });
    await proc.completeTrace(done.id, 'the outcome', true);

    const result = await reembedAllVectors(testEnv);

    expect(result.totalErrors).toBe(0);
    // 1 message + 1 entity + 1 pref + 1 fact + 2 traces (pending + done)
    expect(result.totalProcessed).toBe(6);
    expect(result.totalUpdated).toBe(6);

    // Vectors still resolvable by their original IDs.
    const msgVec = await testEnv.VEC_MESSAGES.getByIds([msg.vector_id!]);
    expect(msgVec).toHaveLength(1);
    const entVec = await testEnv.VEC_ENTITIES.getByIds([ent.vector_id!]);
    expect(entVec).toHaveLength(1);
    const prefVec = await testEnv.VEC_PREFERENCES.getByIds([pref.vector_id!]);
    expect(prefVec).toHaveLength(1);
    const factVec = await testEnv.VEC_FACTS.getByIds([fact.vector_id!]);
    expect(factVec).toHaveLength(1);
    const pendingVec = await testEnv.VEC_TRACES.getByIds([pending.id]);
    expect(pendingVec).toHaveLength(1);
    expect(pendingVec[0]!.metadata?.success).toBe('pending');
    const doneVec = await testEnv.VEC_TRACES.getByIds([done.id]);
    expect(doneVec).toHaveLength(1);
    expect(doneVec[0]!.metadata?.success).toBe('true');
  });

  it('is idempotent — running twice produces the same state', async () => {
    const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
    await ltm.addEntity({ name: 'IdemEntity', entity_type: 'PERSON' });

    const first = await reembedAllVectors(testEnv);
    const second = await reembedAllVectors(testEnv);

    expect(first.totalUpdated).toBe(1);
    expect(second.totalUpdated).toBe(1);
    expect(second.totalErrors).toBe(0);
  });
});
