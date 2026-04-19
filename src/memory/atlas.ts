import type { Bindings } from '../types';

export interface ProjectSummary {
  id: string;
  display_name: string | null;
  created_at: string;
  metadata: string;
  archived: boolean;
  entities: number;
  sessions: number;
  traces: number;
  preferences: number;
  facts: number;
  user_count: number;
  /** user_ids that have any data in this project, sorted alphabetically. */
  users_present: string[];
  last_activity: string | null;
}

export interface UserSummary {
  id: string;
  display_name: string | null;
  created_at: string;
  metadata: string;
  entities: number;
  sessions: number;
  traces: number;
  project_count: number;
  /** project_ids that have any data for this user, sorted alphabetically. */
  projects_present: string[];
  last_activity: string | null;
}

export interface Atlas {
  projects: ProjectSummary[];
  users: UserSummary[];
}

interface CountRow { key: string; c: number }
interface PairRow { project_id: string; user_id: string }
interface MaxRow { key: string; m: string | null }

/**
 * Cross-scope directory of every project and user with per-row counts.
 * Read-only, deliberately ignores X-Project-Id / X-User-Id headers.
 *
 * Counts are split into parallel grouped queries instead of one big
 * aggregate so each scan touches only its own table — D1 plans these
 * as straight index scans on the (project_id, ...) composite indexes.
 */
export async function getAtlas(env: Bindings, opts: { includeArchived?: boolean } = {}): Promise<Atlas> {
  const projectsSql = opts.includeArchived
    ? `SELECT id, display_name, created_at, metadata, archived FROM projects ORDER BY created_at DESC`
    : `SELECT id, display_name, created_at, metadata, archived FROM projects WHERE archived = 0 ORDER BY created_at DESC`;

  const [
    projectsRes,
    usersRes,
    entityProjects,
    sessionProjects,
    traceProjects,
    prefProjects,
    factProjects,
    entityUsers,
    sessionUsers,
    traceUsers,
    projectUserPairs,
    entityActivity,
    sessionActivity,
    traceActivity,
  ] = await Promise.all([
    env.DB.prepare(projectsSql).all<{
      id: string;
      display_name: string | null;
      created_at: string;
      metadata: string;
      archived: number;
    }>(),
    env.DB.prepare(`SELECT id, display_name, created_at, metadata FROM users ORDER BY created_at DESC`).all<{
      id: string;
      display_name: string | null;
      created_at: string;
      metadata: string;
    }>(),
    env.DB.prepare(`SELECT project_id AS key, COUNT(*) AS c FROM entities GROUP BY project_id`).all<CountRow>(),
    env.DB.prepare(`SELECT project_id AS key, COUNT(*) AS c FROM sessions GROUP BY project_id`).all<CountRow>(),
    env.DB.prepare(`SELECT project_id AS key, COUNT(*) AS c FROM reasoning_traces GROUP BY project_id`).all<CountRow>(),
    env.DB.prepare(`SELECT project_id AS key, COUNT(*) AS c FROM preferences GROUP BY project_id`).all<CountRow>(),
    env.DB.prepare(`SELECT project_id AS key, COUNT(*) AS c FROM facts GROUP BY project_id`).all<CountRow>(),
    env.DB.prepare(`SELECT user_id AS key, COUNT(*) AS c FROM entities GROUP BY user_id`).all<CountRow>(),
    env.DB.prepare(`SELECT user_id AS key, COUNT(*) AS c FROM sessions GROUP BY user_id`).all<CountRow>(),
    env.DB.prepare(`SELECT user_id AS key, COUNT(*) AS c FROM reasoning_traces GROUP BY user_id`).all<CountRow>(),
    env.DB.prepare(
      `SELECT DISTINCT project_id, user_id FROM entities
       UNION
       SELECT DISTINCT project_id, user_id FROM sessions
       UNION
       SELECT DISTINCT project_id, user_id FROM reasoning_traces`
    ).all<PairRow>(),
    env.DB.prepare(`SELECT project_id AS key, MAX(updated_at) AS m FROM entities GROUP BY project_id`).all<MaxRow>(),
    env.DB.prepare(`SELECT project_id AS key, MAX(updated_at) AS m FROM sessions GROUP BY project_id`).all<MaxRow>(),
    env.DB.prepare(`SELECT project_id AS key, MAX(started_at) AS m FROM reasoning_traces GROUP BY project_id`).all<MaxRow>(),
  ]);

  const toMap = (rows: { results: CountRow[] }): Map<string, number> =>
    new Map(rows.results.map((r) => [r.key, r.c]));
  const toMaxMap = (rows: { results: MaxRow[] }): Map<string, string> => {
    const m = new Map<string, string>();
    for (const r of rows.results) {
      if (r.m) m.set(r.key, r.m);
    }
    return m;
  };

  const eByP = toMap(entityProjects);
  const sByP = toMap(sessionProjects);
  const tByP = toMap(traceProjects);
  const pByP = toMap(prefProjects);
  const fByP = toMap(factProjects);
  const eByU = toMap(entityUsers);
  const sByU = toMap(sessionUsers);
  const tByU = toMap(traceUsers);

  const eAct = toMaxMap(entityActivity);
  const sAct = toMaxMap(sessionActivity);
  const tAct = toMaxMap(traceActivity);

  // Per-project user set, per-user project set
  const usersInProject = new Map<string, Set<string>>();
  const projectsForUser = new Map<string, Set<string>>();
  for (const pair of projectUserPairs.results) {
    if (!usersInProject.has(pair.project_id)) usersInProject.set(pair.project_id, new Set());
    usersInProject.get(pair.project_id)!.add(pair.user_id);
    if (!projectsForUser.has(pair.user_id)) projectsForUser.set(pair.user_id, new Set());
    projectsForUser.get(pair.user_id)!.add(pair.project_id);
  }

  const maxIso = (...candidates: (string | undefined)[]): string | null => {
    let best: string | null = null;
    for (const c of candidates) {
      if (c && (!best || c > best)) best = c;
    }
    return best;
  };

  const projects: ProjectSummary[] = projectsRes.results.map((p) => {
    const users = Array.from(usersInProject.get(p.id) ?? []).sort();
    return {
      id: p.id,
      display_name: p.display_name,
      created_at: p.created_at,
      metadata: p.metadata,
      archived: p.archived === 1,
      entities: eByP.get(p.id) ?? 0,
      sessions: sByP.get(p.id) ?? 0,
      traces: tByP.get(p.id) ?? 0,
      preferences: pByP.get(p.id) ?? 0,
      facts: fByP.get(p.id) ?? 0,
      user_count: users.length,
      users_present: users,
      last_activity: maxIso(eAct.get(p.id), sAct.get(p.id), tAct.get(p.id)),
    };
  });

  // For users, aggregate activity from any project they're seen in
  const userActivity = new Map<string, string>();
  for (const pair of projectUserPairs.results) {
    const candidates = [eAct.get(pair.project_id), sAct.get(pair.project_id), tAct.get(pair.project_id)];
    for (const c of candidates) {
      if (!c) continue;
      const cur = userActivity.get(pair.user_id);
      if (!cur || c > cur) userActivity.set(pair.user_id, c);
    }
  }

  const users: UserSummary[] = usersRes.results.map((u) => {
    const projs = Array.from(projectsForUser.get(u.id) ?? []).sort();
    return {
      id: u.id,
      display_name: u.display_name,
      created_at: u.created_at,
      metadata: u.metadata,
      entities: eByU.get(u.id) ?? 0,
      sessions: sByU.get(u.id) ?? 0,
      traces: tByU.get(u.id) ?? 0,
      project_count: projs.length,
      projects_present: projs,
      last_activity: userActivity.get(u.id) ?? null,
    };
  });

  // Sort by activity desc, then by id, so the busiest scopes float up
  const byActivity = (a: { last_activity: string | null; id: string }, b: { last_activity: string | null; id: string }) => {
    if (a.last_activity && b.last_activity) return b.last_activity.localeCompare(a.last_activity);
    if (a.last_activity) return -1;
    if (b.last_activity) return 1;
    return a.id.localeCompare(b.id);
  };

  return {
    projects: projects.sort(byActivity),
    users: users.sort(byActivity),
  };
}
