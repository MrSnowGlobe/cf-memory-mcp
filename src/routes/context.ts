import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import type { ContextRequestInput } from '../utils/validation';
import {
  PromoteRequestSchema,
  ContextRequestSchema,
  SnapshotQuerySchema,
} from '../utils/validation';
import { buildContext } from '../memory/context';
import { promote } from '../memory/promotion';
import { getGraphSnapshot } from '../memory/snapshot';
import { getAtlas } from '../memory/atlas';
import { hashText } from '../services/embeddings';
import { logError } from '../services/logger';
import { CACHE_TTL } from '../config';
import { tryWaitUntil } from './_shared';

const app = new Hono<AppType>();

interface CachedContextResponse {
  context: string;
  errors?: { source: string; message: string }[];
}

/**
 * Stable canonical form of a context request body for cache keying. Sort
 * object keys so two semantically-identical bodies (different field order)
 * land on the same cache entry; sort `include` because it's an unordered
 * set of section flags.
 */
function canonicalizeContextBody(body: ContextRequestInput): string {
  const include = body.include ? [...body.include].sort() : undefined;
  const limits = body.limits
    ? Object.keys(body.limits)
        .sort()
        .reduce<Record<string, number>>((acc, k) => {
          const v = (body.limits as Record<string, number | undefined>)[k];
          if (v !== undefined) acc[k] = v;
          return acc;
        }, {})
    : undefined;
  return JSON.stringify({
    query: body.query,
    session_id: body.session_id,
    include,
    limits,
  });
}

app.post(
  '/api/v1/promote',
  zValidator('json', PromoteRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const result = await promote(
      c.env,
      c.get('projectId'),
      c.get('userId'),
      body.type,
      body.id,
      body.reason,
      body.target ?? 'global'
    );
    return c.json(result, 201);
  }
);

app.post(
  '/api/v1/context',
  zValidator('json', ContextRequestSchema),
  async (c) => {
    const body = c.req.valid('json');
    const projectId = c.get('projectId');
    const userId = c.get('userId');

    // KV cache by sha256 of the canonical body, scoped to the auth tenant
    // so projects/users can never read each other's results. Short TTL —
    // see CACHE_TTL.contextSeconds — covers typo fixes / re-asks without
    // making freshly-added memory invisible on follow-up reads.
    const bodyHash = await hashText(canonicalizeContextBody(body));
    const cacheKey = `ctx:${projectId}:${userId}:${bodyHash}`;

    try {
      const hit = await c.env.CACHE.get<CachedContextResponse>(cacheKey, 'json');
      if (hit) {
        c.header('X-Cache', 'HIT');
        return c.json(hit);
      }
    } catch (err) {
      // Cache read failure must never block the request — fall through to
      // a fresh build. Log so we notice persistent KV degradation.
      logError('context_cache_get_failed', err, { component: 'context-cache' });
    }

    const result = await buildContext(c.env, projectId, userId, body);
    const response: CachedContextResponse =
      result.errors.length > 0
        ? { context: result.context, errors: result.errors }
        : { context: result.context };

    // Skip caching partial-failure responses so a transient downstream
    // hiccup can't poison the cache for the TTL window.
    if (result.errors.length === 0) {
      const putPromise = c.env.CACHE.put(cacheKey, JSON.stringify(response), {
        expirationTtl: CACHE_TTL.contextSeconds,
      }).catch((err) => {
        logError('context_cache_put_failed', err, { component: 'context-cache' });
      });
      const defer = tryWaitUntil(c);
      if (defer) {
        defer(putPromise);
      } else {
        // Tests / non-Worker contexts: await inline so the put isn't lost
        // when the request handler returns.
        await putPromise;
      }
    }

    c.header('X-Cache', 'MISS');
    return c.json(response);
  }
);

app.get('/api/v1/atlas', async (c) => {
  const includeArchived = c.req.query('include_archived') === 'true';
  const atlas = await getAtlas(c.env, { includeArchived });
  return c.json(atlas);
});

app.get('/api/v1/snapshot', zValidator('query', SnapshotQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const snapshot = await getGraphSnapshot(c.env, c.get('projectId'), c.get('userId'), {
    entityLimit: q.entity_limit,
    relationLimit: q.relation_limit,
    messageLimit: q.message_limit,
    traceLimit: q.trace_limit,
    preferenceLimit: q.preference_limit,
    factLimit: q.fact_limit,
  });
  return c.json(snapshot);
});

export default app;
