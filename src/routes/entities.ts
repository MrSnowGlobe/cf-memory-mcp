import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import {
  AddEntitySchema,
  UpdateEntitySchema,
  AddRelationSchema,
  TraverseRelationsSchema,
  SearchQuerySchema,
} from '../utils/validation';
import { ltm } from './_shared';

const app = new Hono<AppType>();

app.post(
  '/api/v1/entities',
  zValidator('json', AddEntitySchema),
  async (c) => {
    const body = c.req.valid('json');
    const entity = await ltm(c).addEntity(body);
    return c.json(entity, 201);
  }
);

app.get('/api/v1/entities/:id', async (c) => {
  const entity = await ltm(c).getEntity(c.req.param('id'));
  if (!entity) {
    return c.json({ error: 'Entity not found' }, 404);
  }
  return c.json(entity);
});

app.put(
  '/api/v1/entities/:id',
  zValidator('json', UpdateEntitySchema),
  async (c) => {
    const body = c.req.valid('json');
    const entity = await ltm(c).updateEntity(c.req.param('id'), body);
    return c.json(entity);
  }
);

app.delete('/api/v1/entities/:id', async (c) => {
  await ltm(c).deleteEntity(c.req.param('id'));
  return c.body(null, 204);
});

app.post(
  '/api/v1/entities/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await ltm(c).searchEntities(body.query, body.limit);
    return c.json(results);
  }
);

app.post(
  '/api/v1/entities/:id/relations',
  zValidator('json', AddRelationSchema),
  async (c) => {
    const body = c.req.valid('json');
    const relation = await ltm(c).addRelation(
      c.req.param('id'),
      body.target_entity_id,
      body.relation_type,
      body.metadata,
      body.relation_strength
    );
    return c.json(relation, 201);
  }
);

app.get('/api/v1/entities/:id/relations', async (c) => {
  const relations = await ltm(c).getRelations(c.req.param('id'));
  return c.json(relations);
});

app.post(
  '/api/v1/entities/:id/traverse',
  zValidator('json', TraverseRelationsSchema),
  async (c) => {
    const body = c.req.valid('json');
    const neighbors = await ltm(c).traverseRelations(c.req.param('id'), {
      maxDepth: body.max_depth,
      relationTypes: body.relation_types,
      direction: body.direction,
      limit: body.limit,
    });
    return c.json(neighbors);
  }
);

app.post(
  '/api/v1/entities/:id/subgraph',
  zValidator('json', TraverseRelationsSchema),
  async (c) => {
    const body = c.req.valid('json');
    const subgraph = await ltm(c).traverseSubgraph(c.req.param('id'), {
      maxDepth: body.max_depth,
      relationTypes: body.relation_types,
      direction: body.direction,
      limit: body.limit,
    });
    return c.json(subgraph);
  }
);

export default app;
