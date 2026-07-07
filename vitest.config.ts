import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(resolve('./migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        // Proxy bindings marked `remote = true` in wrangler.toml (AI,
        // Vectorize) to the real Cloudflare services — neither has a local
        // simulator. Requires a valid `wrangler login`; without one the run
        // fails at startup rather than per-test.
        remoteBindings: true,
        miniflare: {
          d1Databases: ['DB'],
          kvNamespaces: ['CACHE'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
  };
});
