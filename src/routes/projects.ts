import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AppType } from '../types';
import {
  rememberProject,
  forgetProject,
} from '../middleware/project-scope';
import { CreateProjectSchema, UpdateProjectSchema } from '../utils/validation';

const app = new Hono<AppType>();

// Idempotent: returns the existing row with 200 if the ID is already
// registered, creates a new row with 201 otherwise. Making register safe
// to call every session is the "user-friendly" half of the registration
// gate — clients don't need to probe-then-create.
app.post(
  '/api/v1/projects',
  zValidator('json', CreateProjectSchema),
  async (c) => {
    const body = c.req.valid('json');
    const existing = await c.env.DB.prepare(
      'SELECT id, display_name, created_at, metadata, archived FROM projects WHERE id = ?'
    )
      .bind(body.id)
      .first<{
        id: string;
        display_name: string | null;
        created_at: string;
        metadata: string;
        archived: number;
      }>();

    if (existing) {
      rememberProject(existing.id);
      return c.json(existing, 200);
    }

    const now = new Date().toISOString();
    const metaJson = JSON.stringify(body.metadata ?? {});
    await c.env.DB.prepare(
      'INSERT INTO projects (id, display_name, created_at, metadata) VALUES (?, ?, ?, ?)'
    )
      .bind(body.id, body.display_name ?? null, now, metaJson)
      .run();

    rememberProject(body.id);
    return c.json(
      {
        id: body.id,
        display_name: body.display_name ?? null,
        created_at: now,
        metadata: metaJson,
        archived: 0,
      },
      201
    );
  }
);

app.get('/api/v1/projects', async (c) => {
  const includeArchived = c.req.query('include_archived') === 'true';
  const sql = includeArchived
    ? 'SELECT * FROM projects ORDER BY created_at DESC'
    : 'SELECT * FROM projects WHERE archived = 0 ORDER BY created_at DESC';
  const result = await c.env.DB.prepare(sql).all();
  return c.json(result.results);
});

app.patch(
  '/api/v1/projects/:id',
  zValidator('json', UpdateProjectSchema),
  async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');

    const existing = await c.env.DB.prepare(
      'SELECT id FROM projects WHERE id = ?'
    )
      .bind(id)
      .first();
    if (!existing) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (body.display_name !== undefined) {
      sets.push('display_name = ?');
      values.push(body.display_name);
    }
    if (body.archived !== undefined) {
      sets.push('archived = ?');
      values.push(body.archived ? 1 : 0);
    }
    if (body.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(JSON.stringify(body.metadata));
    }
    values.push(id);

    await c.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    const updated = await c.env.DB.prepare(
      'SELECT id, display_name, created_at, metadata, archived FROM projects WHERE id = ?'
    )
      .bind(id)
      .first();
    return c.json(updated);
  }
);

// Hard-delete a project only when no data references it. We check every
// child table; if any has rows, we refuse with a breakdown so the caller
// knows what to clean up (or can archive instead).
app.delete('/api/v1/projects/:id', async (c) => {
  const id = c.req.param('id');

  if (id === 'default' || id === 'global') {
    return c.json({ error: `Cannot delete reserved project '${id}'` }, 400);
  }

  const [sessions, entities, preferences, facts, traces] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS c FROM sessions WHERE project_id = ?')
      .bind(id)
      .first<{ c: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS c FROM entities WHERE project_id = ?')
      .bind(id)
      .first<{ c: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS c FROM preferences WHERE project_id = ?')
      .bind(id)
      .first<{ c: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS c FROM facts WHERE project_id = ?')
      .bind(id)
      .first<{ c: number }>(),
    c.env.DB.prepare(
      'SELECT COUNT(*) AS c FROM reasoning_traces WHERE project_id = ?'
    )
      .bind(id)
      .first<{ c: number }>(),
  ]);

  const counts = {
    sessions: sessions?.c ?? 0,
    entities: entities?.c ?? 0,
    preferences: preferences?.c ?? 0,
    facts: facts?.c ?? 0,
    traces: traces?.c ?? 0,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (total > 0) {
    return c.json(
      {
        error: `Project '${id}' has data and cannot be deleted`,
        code: 'PROJECT_NOT_EMPTY',
        counts,
        hint: 'Archive it instead (PATCH with archived=true), or remove the underlying data first.',
      },
      409
    );
  }

  await c.env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  forgetProject(id);
  return c.body(null, 204);
});

export default app;
