import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(resolve('./migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        // Don't open a remote proxy session at startup — it hard-fails the
        // whole run when wrangler auth is missing/expired. AI/Vectorize
        // calls fail per-test instead, matching the pre-0.18 behaviour
        // (run `wrangler login` for the two tests that embed for real).
        remoteBindings: false,
        miniflare: {
          d1Databases: ['DB'],
          kvNamespaces: ['CACHE'],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
  };
});
