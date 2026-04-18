import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { resolve } from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(resolve('./migrations'));

  return {
    test: {
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          miniflare: {
            d1Databases: ['DB'],
            kvNamespaces: ['CACHE'],
            bindings: { TEST_MIGRATIONS: migrations },
          },
        },
      },
    },
  };
});
