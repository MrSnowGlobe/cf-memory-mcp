import type { D1Migration } from '@cloudflare/vitest-pool-workers/config';

// vitest-pool-workers ≥0.18 types `env` from cloudflare:test as the global
// `Cloudflare.Env` (the interface `wrangler types` generates) instead of the
// old module-local `ProvidedEnv`.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      CACHE: KVNamespace;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
