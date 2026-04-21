import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import {
  AddFactSchema,
  UpdateFactSchema,
  InvalidateFactSchema,
  SearchQuerySchema,
} from '../utils/validation';
import { ltm } from './_shared';

const app = new Hono<AppType>();

app.post(
  '/api/v1/facts',
  zValidator('json', AddFactSchema),
  async (c) => {
    const body = c.req.valid('json');
    const fact = await ltm(c).addFact(body);
    return c.json(fact, 201);
  }
);

app.get('/api/v1/facts', async (c) => {
  const subject = c.req.query('subject');
  const predicate = c.req.query('predicate');
  const facts = await ltm(c).listFacts({ subject, predicate });
  return c.json(facts);
});

app.post(
  '/api/v1/facts/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await ltm(c).searchFacts(body.query, body.limit);
    return c.json(results);
  }
);

app.put(
  '/api/v1/facts/:id/invalidate',
  zValidator('json', InvalidateFactSchema),
  async (c) => {
    const body = c.req.valid('json');
    await ltm(c).invalidateFact(c.req.param('id'), body.valid_until);
    return c.json({ success: true });
  }
);

app.put(
  '/api/v1/facts/:id',
  zValidator('json', UpdateFactSchema),
  async (c) => {
    const body = c.req.valid('json');
    const updated = await ltm(c).updateFact(c.req.param('id'), body);
    return c.json(updated);
  }
);

export default app;
