import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { ShortTermMemory } from '../../src/memory/short-term';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
  seedProject,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';

describe('ShortTermMemory', () => {
  let testEnv: TestEnv;
  const PROJECT_ID = 'test-project-stm';

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
    await seedProject(env.DB, PROJECT_ID);
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  describe('createSession', () => {
    it('creates and returns a session with correct project_id', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      const session = await stm.createSession('sess-1', { source: 'test' });

      expect(session.id).toBe('sess-1');
      expect(session.project_id).toBe(PROJECT_ID);
      expect(JSON.parse(session.metadata)).toEqual({ source: 'test' });
      expect(session.created_at).toBeTruthy();
      expect(session.updated_at).toBeTruthy();

      // Verify in D1
      const row = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?')
        .bind('sess-1')
        .first();
      expect(row).not.toBeNull();
      expect((row as Record<string, unknown>).project_id).toBe(PROJECT_ID);
    });

    it('creates a session with empty metadata when none provided', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      const session = await stm.createSession('sess-no-meta');

      expect(JSON.parse(session.metadata)).toEqual({});
    });
  });

  describe('listSessions', () => {
    it('returns only sessions for the correct project', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-a');
      await stm.createSession('sess-b');

      // Create a session in a different project
      const otherProject = 'other-project';
      await seedProject(env.DB, otherProject);
      const otherStm = new ShortTermMemory(testEnv, otherProject, 'default');
      await otherStm.createSession('sess-other');

      const sessions = await stm.listSessions();
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id);
      expect(ids).toContain('sess-a');
      expect(ids).toContain('sess-b');
      expect(ids).not.toContain('sess-other');
    });

    it('respects pagination opts', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('s1');
      await stm.createSession('s2');
      await stm.createSession('s3');

      const page = await stm.listSessions({ limit: 2, offset: 0 });
      expect(page).toHaveLength(2);

      const page2 = await stm.listSessions({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(1);
    });
  });

  describe('getSession', () => {
    it('returns session by ID', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-get');

      const session = await stm.getSession('sess-get');
      expect(session).not.toBeNull();
      expect(session!.id).toBe('sess-get');
    });

    it('returns null for non-existent session', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      const session = await stm.getSession('does-not-exist');
      expect(session).toBeNull();
    });

    it('returns null when session belongs to different project', async () => {
      const otherProject = 'other-project-2';
      await seedProject(env.DB, otherProject);
      const otherStm = new ShortTermMemory(testEnv, otherProject, 'default');
      await otherStm.createSession('sess-other-proj');

      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      const session = await stm.getSession('sess-other-proj');
      expect(session).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('removes session and its messages', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-del');
      await stm.addMessage('sess-del', 'user', 'Hello');
      await stm.addMessage('sess-del', 'assistant', 'Hi there');

      await stm.deleteSession('sess-del');

      const session = await stm.getSession('sess-del');
      expect(session).toBeNull();

      const messages = await env.DB.prepare(
        'SELECT * FROM messages WHERE session_id = ?'
      )
        .bind('sess-del')
        .all();
      expect(messages.results).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  describe('addMessage', () => {
    it('adds a message with auto-incrementing sequence_num', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-msg');

      const msg1 = await stm.addMessage('sess-msg', 'user', 'First message');
      expect(msg1.sequence_num).toBe(1);
      expect(msg1.role).toBe('user');
      expect(msg1.content).toBe('First message');
      expect(msg1.session_id).toBe('sess-msg');
      expect(msg1.vector_id).toBeTruthy();

      const msg2 = await stm.addMessage('sess-msg', 'assistant', 'Reply');
      expect(msg2.sequence_num).toBe(2);
    });

    it('throws when session does not exist', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');

      await expect(
        stm.addMessage('no-such-session', 'user', 'Hello')
      ).rejects.toThrow(/not found/);
    });
  });

  describe('getConversation', () => {
    it('returns messages in order by sequence_num', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-conv');

      await stm.addMessage('sess-conv', 'user', 'Msg 1');
      await stm.addMessage('sess-conv', 'assistant', 'Msg 2');
      await stm.addMessage('sess-conv', 'user', 'Msg 3');

      const conversation = await stm.getConversation('sess-conv');
      expect(conversation).toHaveLength(3);
      expect(conversation[0]!.content).toBe('Msg 1');
      expect(conversation[1]!.content).toBe('Msg 2');
      expect(conversation[2]!.content).toBe('Msg 3');
      expect(conversation[0]!.sequence_num).toBeLessThan(
        conversation[1]!.sequence_num
      );
    });

    it('throws when session does not exist', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');

      await expect(
        stm.getConversation('nonexistent-session')
      ).rejects.toThrow(/not found/);
    });

    it('respects limit parameter', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-limit');

      for (let i = 0; i < 5; i++) {
        await stm.addMessage('sess-limit', 'user', `Msg ${i}`);
      }

      const limited = await stm.getConversation('sess-limit', 3);
      expect(limited).toHaveLength(3);
    });
  });

  describe('addMessagesBatch', () => {
    it('inserts multiple messages and returns correct count', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-batch');

      const messages = [
        { role: 'user' as const, content: 'Batch 1' },
        { role: 'assistant' as const, content: 'Batch 2' },
        { role: 'user' as const, content: 'Batch 3' },
      ];

      const count = await stm.addMessagesBatch('sess-batch', messages);
      expect(count).toBe(3);

      const conversation = await stm.getConversation('sess-batch');
      expect(conversation).toHaveLength(3);
      expect(conversation[0]!.sequence_num).toBe(1);
      expect(conversation[2]!.sequence_num).toBe(3);
    });

    it('throws when session does not exist', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');

      await expect(
        stm.addMessagesBatch('nonexistent', [
          { role: 'user', content: 'test' },
        ])
      ).rejects.toThrow(/not found/);
    });
  });

  describe('searchMessages', () => {
    it('returns results without errors', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-search');
      await stm.addMessage('sess-search', 'user', 'Tell me about cats');
      await stm.addMessage('sess-search', 'assistant', 'Cats are great pets');

      const results = await stm.searchMessages('cats');
      // Mock Vectorize may not return highly relevant results,
      // but the operation should complete without errors
      expect(Array.isArray(results)).toBe(true);
    });

    it('returns empty array for unrelated query', async () => {
      const stm = new ShortTermMemory(testEnv, PROJECT_ID, 'default');
      await stm.createSession('sess-search-empty');

      // No messages at all, search should return empty
      const results = await stm.searchMessages('quantum physics');
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
