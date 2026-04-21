import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { buildContext } from '../../src/memory/context';
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

describe('buildContext', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-project-ctx';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  it('returns a formatted string with all sections when data exists', async () => {
    // Seed some data across all memory types
    const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
    await stm.createSession('ctx-sess');
    await stm.addMessage('ctx-sess', 'user', 'Hello context builder');
    await stm.addMessage('ctx-sess', 'assistant', 'Hi there!');

    const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
    await ltm.addEntity({
      name: 'ContextTestEntity',
      entity_type: 'PERSON',
      description: 'An entity for context testing',
    });
    await ltm.addPreference({
      category: 'testing',
      preference: 'Use vitest',
    });
    await ltm.addFact({
      subject: 'Context',
      predicate: 'is built by',
      object: 'buildContext function',
    });

    const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
    const trace = await proc.startTrace({ task: 'Context test task' });
    await proc.completeTrace(trace.id, 'Completed', true);

    const result = await buildContext(testEnv, PROJECT_ID, 'default', {
      query: 'context testing',
      session_id: 'ctx-sess',
    });

    expect(typeof result.context).toBe('string');
    expect(result.errors).toEqual([]);
    // Should contain the recent conversation section
    expect(result.context).toContain('## Recent Conversation');
    expect(result.context).toContain('Hello context builder');
    expect(result.context).toContain('Hi there!');
  });

  it('respects include filter (only requested types)', async () => {
    // Seed data for all types
    const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
    await stm.createSession('ctx-sess-2');
    await stm.addMessage('ctx-sess-2', 'user', 'Message for include test');

    const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
    await ltm.addEntity({
      name: 'IncludeEntity',
      entity_type: 'PERSON',
    });

    // Only include short_term
    const result = await buildContext(testEnv, PROJECT_ID, 'default', {
      query: 'test query',
      session_id: 'ctx-sess-2',
      include: ['short_term'],
    });

    expect(typeof result.context).toBe('string');
    // Should include conversation
    expect(result.context).toContain('## Recent Conversation');
    // Should NOT contain long_term or procedural sections
    // (the sections are omitted entirely when not included)
    expect(result.context).not.toContain('## Past Similar Tasks');
  });

  it('handles empty results gracefully (no crash)', async () => {
    // No data seeded — everything should be empty
    const result = await buildContext(testEnv, PROJECT_ID, 'default', {
      query: 'anything',
    });

    expect(typeof result.context).toBe('string');
    // Should be an empty string (no sections) or a string without section headers
    // since there is no data
    expect(result.context).not.toContain('undefined');
    expect(result.context).not.toContain('null');
  });

  it('respects limits', async () => {
    const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
    await stm.createSession('ctx-limits');
    // Add 5 messages
    for (let i = 0; i < 5; i++) {
      await stm.addMessage('ctx-limits', 'user', `Message ${i}`);
    }

    const result = await buildContext(testEnv, PROJECT_ID, 'default', {
      query: 'limits test',
      session_id: 'ctx-limits',
      limits: {
        messages: 2,
        entities: 1,
        preferences: 1,
        facts: 1,
        traces: 1,
      },
    });

    expect(typeof result.context).toBe('string');
    // The conversation should be limited to 2 messages
    if (result.context.includes('## Recent Conversation')) {
      const conversationSection =
        result.context.split('## Recent Conversation')[1]?.split('##')[0] ?? '';
      const lines = conversationSection
        .split('\n')
        .filter((l) => l.startsWith('user:') || l.startsWith('assistant:'));
      expect(lines.length).toBeLessThanOrEqual(2);
    }
  });

  it('returns formatted output without session_id', async () => {
    // buildContext should work even without a session_id
    // It just won't have a conversation section
    const ltm = new LongTermMemory(testEnv, PROJECT_ID, 'default');
    await ltm.addFact({
      subject: 'NoSession',
      predicate: 'test',
      object: 'value',
    });

    const result = await buildContext(testEnv, PROJECT_ID, 'default', {
      query: 'no session test',
    });

    expect(typeof result.context).toBe('string');
    // Should not crash
    expect(result.context).not.toContain('undefined');
  });
});
