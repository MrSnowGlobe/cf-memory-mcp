import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import {
  PromoteRequestSchema,
  ContextRequestSchema,
} from '../utils/validation';
import { buildContext } from '../memory/context';
import { promote } from '../memory/promotion';
import { getGraphSnapshot } from '../memory/snapshot';
import { getAtlas } from '../memory/atlas';

const app = new Hono<AppType>();

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
    const result = await buildContext(c.env, c.get('projectId'), c.get('userId'), body);
    return c.json(
      result.errors.length > 0
        ? { context: result.context, errors: result.errors }
        : { context: result.context }
    );
  }
);

app.get('/api/v1/atlas', async (c) => {
  const includeArchived = c.req.query('include_archived') === 'true';
  const atlas = await getAtlas(c.env, { includeArchived });
  return c.json(atlas);
});

app.get('/api/v1/snapshot', async (c) => {
  const num = (q: string | undefined): number | undefined =>
    q !== undefined ? Number(q) : undefined;
  const snapshot = await getGraphSnapshot(c.env, c.get('projectId'), c.get('userId'), {
    entityLimit: num(c.req.query('entity_limit')),
    relationLimit: num(c.req.query('relation_limit')),
    messageLimit: num(c.req.query('message_limit')),
    traceLimit: num(c.req.query('trace_limit')),
    preferenceLimit: num(c.req.query('preference_limit')),
    factLimit: num(c.req.query('fact_limit')),
  });
  return c.json(snapshot);
});

export default app;
