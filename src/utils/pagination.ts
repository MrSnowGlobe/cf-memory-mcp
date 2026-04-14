import type { PaginationOpts } from '../types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function parsePagination(opts?: PaginationOpts): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(opts?.offset ?? 0, 0);
  return { limit, offset };
}
