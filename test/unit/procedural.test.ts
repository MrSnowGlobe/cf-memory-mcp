import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ProceduralMemory } from '../../src/memory/procedural';
import { ShortTermMemory } from '../../src/memory/short-term';
import {
  applyMigrations,
  clearAllTables,
  clearCache,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('ProceduralMemory', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-project-proc';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    await clearCache(env.CACHE);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  // -------------------------------------------------------------------------
  // Traces
  // -------------------------------------------------------------------------

  describe('startTrace', () => {
    it('creates a trace with correct project_id', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({
        task: 'Analyze code quality',
      });

      expect(trace.project_id).toBe(PROJECT_ID);
      expect(trace.task).toBe('Analyze code quality');
      expect(trace.outcome).toBeNull();
      expect(trace.success).toBeNull();
      expect(trace.completed_at).toBeNull();
      expect(trace.duration_ms).toBeNull();
      expect(trace.started_at).toBeTruthy();

      // Verify in D1
      const row = await env.DB.prepare(
        'SELECT * FROM reasoning_traces WHERE id = ?'
      )
        .bind(trace.id)
        .first();
      expect(row).not.toBeNull();
    });

    it('creates a trace with optional session_id', async () => {
      // Create a session first (needed for FK)
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-proc');

      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({
        task: 'Task with session',
        session_id: 'sess-proc',
      });

      expect(trace.session_id).toBe('sess-proc');
    });
  });

  describe('completeTrace', () => {
    it('sets outcome, success, duration_ms, and completed_at', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({ task: 'Build feature' });

      const completed = await proc.completeTrace(
        trace.id,
        'Feature built successfully',
        true
      );

      expect(completed.outcome).toBe('Feature built successfully');
      expect(completed.success).toBe(1);
      expect(completed.completed_at).toBeTruthy();
      expect(completed.duration_ms).toBeGreaterThanOrEqual(0);
      expect(completed.vector_id).toBe(trace.id);
    });

    it('records failure correctly', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({ task: 'Flawed task' });

      const completed = await proc.completeTrace(
        trace.id,
        'Failed due to timeout',
        false
      );

      expect(completed.success).toBe(0);
      expect(completed.outcome).toBe('Failed due to timeout');
    });

    it('throws for non-existent trace', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');

      await expect(
        proc.completeTrace('nonexistent-trace', 'done', true)
      ).rejects.toThrow(/not found/);
    });
  });

  describe('listTraces', () => {
    it('returns traces for the project', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      await proc.startTrace({ task: 'Task A' });
      await proc.startTrace({ task: 'Task B' });

      const traces = await proc.listTraces();
      expect(traces).toHaveLength(2);
    });

    it('filters by success', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const t1 = await proc.startTrace({ task: 'Success task' });
      const t2 = await proc.startTrace({ task: 'Failure task' });
      await proc.completeTrace(t1.id, 'Done', true);
      await proc.completeTrace(t2.id, 'Failed', false);

      const successTraces = await proc.listTraces({ success: true });
      expect(successTraces).toHaveLength(1);
      expect(successTraces[0]!.task).toBe('Success task');

      const failTraces = await proc.listTraces({ success: false });
      expect(failTraces).toHaveLength(1);
      expect(failTraces[0]!.task).toBe('Failure task');
    });

    it('filters by session_id', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-filter');

      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      await proc.startTrace({ task: 'With session', session_id: 'sess-filter' });
      await proc.startTrace({ task: 'Without session' });

      const filtered = await proc.listTraces({ session_id: 'sess-filter' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.task).toBe('With session');
    });
  });

  describe('searchTraces', () => {
    it('completes without errors', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const t = await proc.startTrace({ task: 'Search test task' });
      await proc.completeTrace(t.id, 'done', true);

      const results = await proc.searchTraces('test');
      expect(Array.isArray(results)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  describe('addStep', () => {
    it('creates step with auto-incrementing step_number', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({ task: 'Step test' });

      const step1 = await proc.addStep(trace.id, {
        thought: 'Think about it',
        action: 'Do the thing',
        observation: 'It worked',
      });
      expect(step1.step_number).toBe(1);
      expect(step1.thought).toBe('Think about it');
      expect(step1.action).toBe('Do the thing');
      expect(step1.observation).toBe('It worked');

      const step2 = await proc.addStep(trace.id, {
        thought: 'Step 2 thought',
      });
      expect(step2.step_number).toBe(2);
    });

    it('throws for non-existent trace', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');

      await expect(
        proc.addStep('nonexistent-trace', { thought: 'test' })
      ).rejects.toThrow(/not found/);
    });
  });

  // -------------------------------------------------------------------------
  // Tool Calls
  // -------------------------------------------------------------------------

  describe('recordToolCall', () => {
    it('inserts tool call and updates tool_stats', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({ task: 'Tool test' });
      const step = await proc.addStep(trace.id, { action: 'call tool' });

      const toolCall = await proc.recordToolCall(step.id, {
        tool_name: 'test_tool',
        arguments: { param: 'value' },
        result: { output: 'result' },
        status: 'success',
        duration_ms: 150,
      });

      expect(toolCall.tool_name).toBe('test_tool');
      expect(toolCall.status).toBe('success');
      expect(toolCall.duration_ms).toBe(150);

      // Verify tool_stats was updated
      const stats = await env.DB.prepare(
        'SELECT * FROM tool_stats WHERE tool_name = ? AND project_id = ?'
      )
        .bind('test_tool', PROJECT_ID)
        .first<{ total_calls: number; success_count: number; failure_count: number }>();

      expect(stats).not.toBeNull();
      expect(stats!.total_calls).toBe(1);
      expect(stats!.success_count).toBe(1);
      expect(stats!.failure_count).toBe(0);
    });

    it('increments stats on multiple calls', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({ task: 'Multi tool test' });
      const step = await proc.addStep(trace.id, { action: 'call tools' });

      await proc.recordToolCall(step.id, {
        tool_name: 'multi_tool',
        status: 'success',
        duration_ms: 100,
      });

      await proc.recordToolCall(step.id, {
        tool_name: 'multi_tool',
        status: 'failure',
        duration_ms: 200,
      });

      await proc.recordToolCall(step.id, {
        tool_name: 'multi_tool',
        status: 'success',
        duration_ms: 50,
      });

      const stats = await env.DB.prepare(
        'SELECT * FROM tool_stats WHERE tool_name = ? AND project_id = ?'
      )
        .bind('multi_tool', PROJECT_ID)
        .first<{
          total_calls: number;
          success_count: number;
          failure_count: number;
          total_duration_ms: number;
        }>();

      expect(stats!.total_calls).toBe(3);
      expect(stats!.success_count).toBe(2);
      expect(stats!.failure_count).toBe(1);
      expect(stats!.total_duration_ms).toBe(350);
    });
  });

  describe('getToolStats', () => {
    it('returns aggregated stats', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const trace = await proc.startTrace({ task: 'Stats test' });
      const step = await proc.addStep(trace.id, { action: 'test' });

      await proc.recordToolCall(step.id, {
        tool_name: 'tool_a',
        status: 'success',
        duration_ms: 10,
      });
      await proc.recordToolCall(step.id, {
        tool_name: 'tool_b',
        status: 'failure',
        duration_ms: 20,
      });

      const stats = await proc.getToolStats();
      expect(stats).toHaveLength(2);

      const toolA = stats.find((s) => s.tool_name === 'tool_a');
      expect(toolA).toBeTruthy();
      expect(toolA!.total_calls).toBe(1);
      expect(toolA!.success_count).toBe(1);
    });

    it('returns empty array when no tools have been called', async () => {
      const proc = new ProceduralMemory(testEnv, PROJECT_ID, 'default');
      const stats = await proc.getToolStats();
      expect(stats).toHaveLength(0);
    });
  });
});
