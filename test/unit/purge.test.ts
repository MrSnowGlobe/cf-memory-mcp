import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { purgeProject } from '../../src/admin/purge-project';
import { ShortTermMemory } from '../../src/memory/short-term';
import { LongTermMemory } from '../../src/memory/long-term';
import { ProceduralMemory } from '../../src/memory/procedural';
import { cacheSet, cacheGet } from '../../src/services/cache';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('purgeProject', () => {
  let testEnv: TestEnv;
  const TARGET = 'test-purge';
  const OTHER = 'other-project';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, TARGET);
    await seedProject(env.DB, OTHER);
  });

  it('refuses reserved project IDs', async () => {
    await expect(purgeProject(testEnv, 'default')).rejects.toThrow(/reserved/);
    await expect(purgeProject(testEnv, 'global')).rejects.toThrow(/reserved/);
  });

  it('returns zero counts when nothing exists for the project', async () => {
    const result = await purgeProject(testEnv, TARGET);
    expect(result.d1.sessions).toBe(0);
    expect(result.d1.entities).toBe(0);
    expect(result.vectors.entities).toBe(0);
    expect(result.kv.keys_deleted).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.d1.projects).toBe(0);
  });

  it('wipes D1 rows, Vectorize entries, and KV keys for the target project', async () => {
    // Seed the target with data across all memory types.
    const stm = new ShortTermMemory(testEnv, TARGET, 'default');
    await stm.createSession('sess-target');
    const msg = await stm.addMessage('sess-target', 'user', 'hello target');

    const ltm = new LongTermMemory(testEnv, TARGET, 'default');
    const ent = await ltm.addEntity({ name: 'Alice', entity_type: 'PERSON' });
    const pref = await ltm.addPreference({ category: 'c', preference: 'p' });
    const fact = await ltm.addFact({ subject: 'S', predicate: 'P', object: 'O' });

    const proc = new ProceduralMemory(testEnv, TARGET, 'default');
    const trace = await proc.startTrace({ task: 'target task' });
    await proc.completeTrace(trace.id, 'done', true);

    // Seed the other project with one of each so we can verify isolation.
    const otherStm = new ShortTermMemory(testEnv, OTHER, 'default');
    await otherStm.createSession('sess-other');
    const otherMsg = await otherStm.addMessage('sess-other', 'user', 'hello other');
    const otherLtm = new LongTermMemory(testEnv, OTHER, 'default');
    const otherEnt = await otherLtm.addEntity({ name: 'Bob', entity_type: 'PERSON' });

    // Seed a KV cache entry for each project.
    await cacheSet(testEnv.CACHE, TARGET, 'default', 'session:sess-target', { foo: 1 }, 60);
    await cacheSet(testEnv.CACHE, OTHER, 'default', 'session:sess-other', { foo: 2 }, 60);

    const result = await purgeProject(testEnv, TARGET);

    // Reported counts include the target rows but not the other project's.
    expect(result.d1.sessions).toBe(1);
    expect(result.d1.messages).toBe(1);
    expect(result.d1.entities).toBe(1);
    expect(result.d1.preferences).toBe(1);
    expect(result.d1.facts).toBe(1);
    expect(result.d1.reasoning_traces).toBe(1);
    expect(result.vectors.messages).toBe(1);
    expect(result.vectors.entities).toBe(1);
    expect(result.vectors.preferences).toBe(1);
    expect(result.vectors.facts).toBe(1);
    expect(result.vectors.traces).toBe(1);
    expect(result.kv.keys_deleted).toBeGreaterThanOrEqual(1);
    expect(result.errors).toEqual([]);

    // Target D1 rows are gone.
    const sessLeft = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS c FROM sessions WHERE project_id = ?'
    )
      .bind(TARGET)
      .first<{ c: number }>();
    expect(sessLeft?.c ?? -1).toBe(0);

    // Target Vectorize entries are gone.
    expect(await testEnv.VEC_MESSAGES.getByIds([msg.vector_id!])).toHaveLength(0);
    expect(await testEnv.VEC_ENTITIES.getByIds([ent.vector_id!])).toHaveLength(0);
    expect(await testEnv.VEC_PREFERENCES.getByIds([pref.vector_id!])).toHaveLength(0);
    expect(await testEnv.VEC_FACTS.getByIds([fact.vector_id!])).toHaveLength(0);
    expect(await testEnv.VEC_TRACES.getByIds([trace.id])).toHaveLength(0);

    // Target KV keys are gone.
    const stillCached = await cacheGet(testEnv.CACHE, TARGET, 'default', 'session:sess-target');
    expect(stillCached).toBeNull();

    // Other project's data is untouched.
    const otherSess = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS c FROM sessions WHERE project_id = ?'
    )
      .bind(OTHER)
      .first<{ c: number }>();
    expect(otherSess?.c ?? 0).toBe(1);
    expect(await testEnv.VEC_MESSAGES.getByIds([otherMsg.vector_id!])).toHaveLength(1);
    expect(await testEnv.VEC_ENTITIES.getByIds([otherEnt.vector_id!])).toHaveLength(1);
    const otherCached = await cacheGet(testEnv.CACHE, OTHER, 'default', 'session:sess-other');
    expect(otherCached).not.toBeNull();

    // `projects` row preserved by default.
    const projRow = await testEnv.DB.prepare('SELECT id FROM projects WHERE id = ?')
      .bind(TARGET)
      .first();
    expect(projRow).not.toBeNull();
    expect(result.d1.projects).toBe(0);
  });

  it('deletes the projects row when deleteProject=true', async () => {
    const ltm = new LongTermMemory(testEnv, TARGET, 'default');
    await ltm.addEntity({ name: 'Ephemeral', entity_type: 'PERSON' });

    const result = await purgeProject(testEnv, TARGET, { deleteProject: true });
    expect(result.d1.projects).toBe(1);

    const projRow = await testEnv.DB.prepare('SELECT id FROM projects WHERE id = ?')
      .bind(TARGET)
      .first();
    expect(projRow).toBeNull();
  });
});
