# Contributing to cf-agent-memory

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers Paid plan for Vectorize and AI)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)

### Local Development

1. Clone the repo and install dependencies:

```bash
git clone <your-repo-url>
cd cf-agent-memory
npm install
```

2. Copy the example config:

```bash
cp wrangler.toml.example wrangler.toml
```

3. Create your Cloudflare resources and update `wrangler.toml` with the real IDs:

```bash
npx wrangler d1 create agent-memory
npx wrangler kv namespace create CACHE
bash scripts/setup-vectorize.sh
```

4. Apply the database migration:

```bash
npx wrangler d1 migrations apply agent-memory --local
```

5. Start the dev server:

```bash
npm run dev
```

### Running Tests

Tests use Vitest with Miniflare (local Cloudflare simulation). No Cloudflare account needed to run tests.

```bash
npm test                                    # Run all tests
npx vitest run test/unit/scoping.test.ts    # Run a specific test file
npx vitest --watch                          # Watch mode
```

All 138 tests should pass before submitting a PR.

## Code Style

- **TypeScript strict mode** — no `any` types
- **Explicit return types** on all exported functions
- **Parameterized SQL** — never interpolate values into SQL strings
- **Memory modules are classes** (`new ShortTermMemory(env, projectId)`)
- **Services are plain functions** taking `env: Env` as the first argument
- **Zod schemas** live in `src/utils/validation.ts`
- **Errors** return `{ error: string }` with appropriate HTTP status codes — don't throw unhandled

## Project Structure

See the [design document](cf-agent-memory-design.md) for full architecture details. Key directories:

```
src/
  router.ts              # Slim assembler — mounts domain sub-apps, wires middleware
  config.ts              # Tunable constants (thresholds, TTLs, cascade boosts)
  types.ts               # Env bindings + D1 row types
  auth/                  # Browser session auth (login / logout / me)
  middleware/            # Bearer + scope + rate-limit middleware
  memory/                # Short-term, long-term, procedural memory classes + context + promotion
  services/              # Embeddings, vectorize (cascadingSearch), cache, entity resolution
  routes/                # Per-domain route modules mounted by router.ts
  mcp/                   # MCP server (Streamable HTTP + SSE transports, 14 tools)
  durable-objects/       # MemoryEventsDO — per-scope WebSocket pub/sub
  admin/                 # One-shot admin helpers (migrate-namespaces, reembed, purge)
  utils/                 # IDs, pagination, Zod schemas, typed errors
test/
  unit/                  # Vitest tests (one file per module)
  helpers/               # Miniflare test environment setup
migrations/              # D1 SQL migrations
public/                  # Observatory visualizer (served as Workers Assets)
```

## Submitting Changes

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Ensure all tests pass: `npm test`
4. Ensure types check: `npm run typecheck`
5. Open a pull request against `main`

### PR Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality
- Update the design doc if you're changing architecture
- Describe *what* and *why* in the PR description

## Critical Rules

These rules exist for data integrity and security. PRs that violate them will be rejected:

1. Every table with user data has both `project_id` and `user_id` columns (descendants inherit via FK cascade)
2. Every Vectorize insert uses `namespace: ${projectId}:${userId}` via `getWriteNamespace()`
3. Every search uses `cascadingSearch()` — never a direct Vectorize `query()` call
4. Writes go to `c.get('projectId')` / `c.get('userId')` from middleware — never from the request body
5. KV keys are always prefixed with `${projectId}:${userId}:` via `cacheGet` / `cacheSet` helpers
6. All IDs are lowercase hex UUIDs (`crypto.randomUUID().replace(/-/g, '')`)
7. All timestamps are ISO 8601 strings (`new Date().toISOString()`)
8. D1 queries must use parameterized `.bind()` — never interpolate values into SQL

## Reporting Issues

Open an issue on GitHub with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (Node version, OS, Wrangler version)

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
