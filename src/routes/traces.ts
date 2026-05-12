import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import {
  StartTraceSchema,
  CompleteTraceSchema,
  AddStepSchema,
  RecordToolCallSchema,
  SearchQuerySchema,
  TraceListQuerySchema,
} from '../utils/validation';
import { pm } from './_shared';

const app = new Hono<AppType>();

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

app.post(
  '/api/v1/traces',
  zValidator('json', StartTraceSchema),
  async (c) => {
    const body = c.req.valid('json');
    const trace = await pm(c).startTrace(body);
    return c.json(trace, 201);
  }
);

app.put(
  '/api/v1/traces/:id/complete',
  zValidator('json', CompleteTraceSchema),
  async (c) => {
    const body = c.req.valid('json');
    const trace = await pm(c).completeTrace(c.req.param('id'), body.outcome, body.success);
    return c.json(trace);
  }
);

app.get('/api/v1/traces', zValidator('query', TraceListQuerySchema), async (c) => {
  const { limit, offset, session_id, success } = c.req.valid('query');
  const successBool =
    success === 'true' ? true : success === 'false' ? false : undefined;
  const traces = await pm(c).listTraces({
    limit,
    offset,
    session_id,
    success: successBool,
  });
  return c.json(traces);
});

app.post(
  '/api/v1/traces/search',
  zValidator('json', SearchQuerySchema),
  async (c) => {
    const body = c.req.valid('json');
    const results = await pm(c).searchTraces(body.query, body.limit);
    return c.json(results);
  }
);

app.get('/api/v1/traces/:id', async (c) => {
  const detail = await pm(c).getTraceDetail(c.req.param('id'));
  if (!detail) {
    return c.json({ error: 'Trace not found' }, 404);
  }
  return c.json(detail);
});

// ---------------------------------------------------------------------------
// Steps & Tool Calls
// ---------------------------------------------------------------------------

app.post(
  '/api/v1/traces/:id/steps',
  zValidator('json', AddStepSchema),
  async (c) => {
    const body = c.req.valid('json');
    const step = await pm(c).addStep(c.req.param('id'), body);
    return c.json(step, 201);
  }
);

app.post(
  '/api/v1/steps/:id/tool-calls',
  zValidator('json', RecordToolCallSchema),
  async (c) => {
    const body = c.req.valid('json');
    const toolCall = await pm(c).recordToolCall(c.req.param('id'), body);
    return c.json(toolCall, 201);
  }
);

app.get('/api/v1/tool-stats', async (c) => {
  const stats = await pm(c).getToolStats();
  return c.json(stats);
});

export default app;
