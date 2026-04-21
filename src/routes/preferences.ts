import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import {
  AddPreferenceSchema,
  UpdatePreferenceSchema,
  SearchQuerySchema,
} from '../utils/validation';
import { ltm } from './_shared';

const app = new Hono<AppType>();

app.post(
  '/api/v1/preferences',
  zValidator('json', AddPreferenceSchema),
  async (c) => {
    const body = c.req.valid('json');
    const preference = await ltm(c).addPreference(body);
    return c.json(preference, 201);
  }
);

app.get('/api/v1/preferences', async (c) => {
  const category = c.req.query('category');
  const preferences = await ltm(c).listPreferences(category);
  return c.json(preferences);
});

app.post(
  '/api/v1/preferences/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await ltm(c).searchPreferences(body.query, body.limit);
    return c.json(results);
  }
);

app.put(
  '/api/v1/preferences/:id',
  zValidator('json', UpdatePreferenceSchema),
  async (c) => {
    const body = c.req.valid('json');
    const updated = await ltm(c).updatePreference(c.req.param('id'), body);
    return c.json(updated);
  }
);

export default app;
