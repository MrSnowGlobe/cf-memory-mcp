import type { Bindings } from '../types';
import { logWarn } from '../services/logger';

/**
 * Shape of an event broadcast to WebSocket subscribers.
 * Kept intentionally small — the client already has /snapshot for full state;
 * events are a signal "something changed, here's the new row's summary."
 */
export interface MemoryEvent {
  type:
    | 'message_added'
    | 'entity_added'
    | 'entity_updated'
    | 'entity_deleted'
    | 'relation_added'
    | 'preference_added'
    | 'preference_updated'
    | 'fact_added'
    | 'fact_updated'
    | 'fact_invalidated'
    | 'trace_started'
    | 'trace_completed'
    | 'promoted';
  scope: { project_id: string; user_id: string };
  ts: string;
  payload: Record<string, unknown>;
}

/**
 * Build the deterministic DO name for a scope. One DO per project+user —
 * events are naturally isolated because each scope's writes route to its
 * own DO and no cross-scope fan-out is needed.
 */
export function scopeDoName(projectId: string, userId: string): string {
  return `${projectId}:${userId}`;
}

/**
 * Durable Object that holds open WebSocket subscribers for a single scope
 * and broadcasts memory events to them.
 *
 * Uses WebSocket Hibernation (state.acceptWebSocket) so the DO isolate is
 * evicted from memory while idle — duration is only billed during message
 * handling, not while waiting. On hibernation wake, state.getWebSockets()
 * returns the live connections so we can fan out without keeping them in
 * a JS-memory list.
 *
 * No persistent storage is used. Late-joining clients don't see history —
 * they already have /snapshot for the full current state, and events from
 * the moment they connect onward are enough for "see it happen."
 */
export class MemoryEventsDO implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Bindings
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade: subscribe to live events.
    if (request.headers.get('Upgrade') === 'websocket') {
      // Defence-in-depth: if the routing layer told us which scope this DO
      // is supposed to be serving, stash it on the first connection and
      // warn loudly if a later upgrade carries a different value. The DO
      // has no other way to verify its own identity, so this catches the
      // class of bug where middleware resolves one scope but the route
      // forwards to another DO (cf. 2026-04-18 query-param-fallback bug).
      const declared = request.headers.get('X-Internal-Scope');
      if (declared) {
        const stored = (await this.state.storage.get<string>('declared_scope')) ?? null;
        if (stored === null) {
          await this.state.storage.put('declared_scope', declared);
        } else if (stored !== declared) {
          logWarn('memory_events_do_scope_mismatch', {
            component: 'memory-events-do',
            message: `DO declared_scope=${stored} but incoming X-Internal-Scope=${declared}`,
          });
        }
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Hibernation-aware accept. The runtime wakes the DO and calls
      // webSocketMessage/Close/Error on this class when the socket sees
      // traffic — we don't need to addEventListener.
      this.state.acceptWebSocket(server);

      // Greet the client so they know the channel is live without waiting
      // for the first real event.
      server.send(
        JSON.stringify({
          type: 'hello',
          ts: new Date().toISOString(),
          connections: this.state.getWebSockets().length,
        })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    // Publish endpoint: called by the publishEvent service on write.
    if (url.pathname === '/publish' && request.method === 'POST') {
      let event: MemoryEvent;
      try {
        event = (await request.json()) as MemoryEvent;
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      this.broadcast(event);
      return new Response(null, { status: 204 });
    }

    return new Response('Not found', { status: 404 });
  }

  private broadcast(event: MemoryEvent): void {
    const payload = JSON.stringify(event);
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Socket is in a bad state; let it be closed by the runtime.
      }
    }
  }

  // --- Hibernation handlers -------------------------------------------------
  // These must be methods on the DO class; the runtime dispatches here when
  // a hibernated socket receives traffic.

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Clients don't need to send anything meaningful. We accept pings so
    // the connection stays warm through corporate proxies but otherwise
    // ignore inbound traffic.
    if (typeof message === 'string' && message === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
    }
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    void ws; void code; void reason; void wasClean;
    // No bookkeeping needed — state.getWebSockets() auto-excludes closed sockets.
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    void ws; void error;
    // Runtime will close the socket. Nothing to do.
  }
}
