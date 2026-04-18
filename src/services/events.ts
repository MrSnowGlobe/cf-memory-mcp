import type { Bindings } from '../types';
import { scopeDoName, type MemoryEvent } from '../durable-objects/memory-events';

export type EventType = MemoryEvent['type'];

/**
 * Publish a memory event to the per-scope Durable Object. No-ops silently
 * when the EVENTS binding is absent (tests, local dev without DO migration
 * applied) so writes never fail because of pub/sub.
 *
 * Errors from the DO are caught and logged; a broken pub/sub must not
 * block a successful write.
 */
export async function publishEvent(
  env: Bindings,
  projectId: string,
  userId: string,
  type: EventType,
  payload: Record<string, unknown>
): Promise<void> {
  const namespace = env.EVENTS;
  if (!namespace) return;

  const event: MemoryEvent = {
    type,
    scope: { project_id: projectId, user_id: userId },
    ts: new Date().toISOString(),
    payload,
  };

  try {
    const id = namespace.idFromName(scopeDoName(projectId, userId));
    const stub = namespace.get(id);
    await stub.fetch('https://do/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch (err) {
    console.error('[events] publish failed:', err);
  }
}
