import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { publishEvent } from '../../src/services/events';
import {
  applyMigrations,
  clearAllTables,
  createTestEnv,
} from '../helpers/setup';
import type { TestEnv } from '../helpers/setup';
import type { Bindings } from '../../src/types';

describe('publishEvent', () => {
  let testEnv: TestEnv;

  beforeEach(async () => {
    await applyMigrations(env.DB);
    await clearAllTables(env.DB);
    testEnv = createTestEnv(env.DB, env.CACHE);
  });

  it('no-ops when EVENTS binding is absent', async () => {
    // testEnv has no EVENTS binding — this must not throw.
    await expect(
      publishEvent(testEnv, 'p', 'u', 'entity_added', { id: 'x' })
    ).resolves.toBeUndefined();
  });

  it('forwards to the right DO and posts the event body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const stub = { fetch: fetchMock };
    const idFromName = vi.fn((name: string) => ({ name } as unknown as DurableObjectId));
    const get = vi.fn(() => stub as unknown as DurableObjectStub);

    const envWithEvents: Bindings = {
      ...testEnv,
      EVENTS: {
        idFromName,
        get,
        // Unused in this test but required by the type
        newUniqueId: vi.fn(),
        idFromString: vi.fn(),
        jurisdiction: vi.fn(),
      } as unknown as DurableObjectNamespace,
    };

    await publishEvent(envWithEvents, 'proj-a', 'user-a', 'message_added', {
      id: 'm1',
      content: 'hi',
    });

    expect(idFromName).toHaveBeenCalledWith('proj-a:user-a');
    expect(get).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall).toBeDefined();
    const init = firstCall[1];
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('message_added');
    expect(body.scope).toEqual({ project_id: 'proj-a', user_id: 'user-a' });
    expect(body.payload).toEqual({ id: 'm1', content: 'hi' });
    expect(typeof body.ts).toBe('string');
  });

  it('swallows DO errors so the caller never fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error('DO offline');
    });
    const stub = { fetch: fetchMock };
    const envWithBadEvents: Bindings = {
      ...testEnv,
      EVENTS: {
        idFromName: vi.fn(() => ({} as DurableObjectId)),
        get: vi.fn(() => stub as unknown as DurableObjectStub),
        newUniqueId: vi.fn(),
        idFromString: vi.fn(),
        jurisdiction: vi.fn(),
      } as unknown as DurableObjectNamespace,
    };

    await expect(
      publishEvent(envWithBadEvents, 'p', 'u', 'fact_added', {})
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
