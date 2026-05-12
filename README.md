# cf-agent-memory

Cloudflare-native agent memory system with semantic search. Three memory types — short-term, long-term, and procedural — built on D1 + Vectorize + KV + Workers AI.

Inspired by [neo4j-labs/agent-memory](https://github.com/neo4j-labs/agent-memory), rebuilt to run entirely on Cloudflare's edge with zero external dependencies.

## Features

- **Three memory types** — short-term (conversations), long-term (entities, preferences, temporal facts), procedural (reasoning traces, tool stats)
- **Semantic search** across all memory types via Vectorize (768-dim embeddings, cosine similarity)
- **Entity resolution** — 3-stage deduplication (exact match, fuzzy Levenshtein >= 0.85, semantic cosine >= 0.8)
- **Graph traversal** — typed relations between entities, K-hop walks, subgraph extraction
- **4-tier scoping** — project+user > user > project > global, with automatic cascading reads and scope-boosted ranking
- **MCP server** — 14 tools over JSON-RPC / Streamable HTTP + SSE, works with Claude Code, Claude Desktop, or any MCP client
- **REST API** — 40+ endpoints for direct integration
- **Live events** — per-scope WebSocket pub/sub via a hibernatable Durable Object; stream writes to any subscribed client
- **Observatory visualizer** — built-in browser UI (served as Workers Assets) with force-directed graph, timeline scrubber, and live activity feed
- **Rate limiting** — three-tier edge-resident limiter (global per-tenant, AI-bound paths, per-MCP-method) via Cloudflare's `ratelimit` bindings
- **Scale-to-zero** — $5/mo base on Cloudflare Workers Paid plan
- **Single deploy** — `npx wrangler deploy`, no infrastructure to manage

## How It Works

### Memory Types

**Short-term memory** stores conversation sessions and messages. Each message is embedded and indexed in Vectorize for semantic retrieval. Recent conversations are cached in KV (60s TTL) for fast access.

**Long-term memory** stores three kinds of knowledge:
- **Entities** — people, objects, locations, events, organizations. Adding an entity runs a 3-stage resolution pipeline (exact name match in D1, fuzzy Levenshtein match >= 0.85, semantic vector match >= 0.8) to prevent duplicates.
- **Preferences** — categorized user preferences (e.g. coding style, tools). Searches apply strict scope precedence: a project-level preference overrides a global one in the same category.
- **Facts** — subject-predicate-object triples with optional temporal validity (`valid_from`/`valid_until`). Expired facts are automatically excluded from queries.

**Procedural memory** records reasoning traces — what the agent tried, what worked, what failed. Each trace contains steps and tool calls. Tool call statistics are pre-aggregated for fast retrieval (5min KV cache).

### Scoping Model

Every request includes a project (`X-Project-Id` header, default: `"default"`) and user (`X-User-Id` header, default: `"default"`). Writes go to the most specific scope. Reads cascade through 4 tiers, with narrower scopes boosted higher:

| Tier | Namespace | Score Boost | Example |
|------|-----------|-------------|---------|
| 0 | project+user | +0.15 | `myapp:alice` |
| 1 | user | +0.10 | `user:alice` |
| 2 | project | +0.05 | `myapp` |
| 3 | global | +0.00 | `global` |

All tier queries fire in parallel. Results are merged, deduplicated by ID (keeping the highest score), and sorted. This means a user's project-specific memories always rank above general knowledge, but global facts are still surfaced when relevant.

**Promotion** copies a memory item to a wider scope (`user` or `global`) without deleting the original. An audit log records every promotion.

### Architecture

```
Client (MCP / REST)
        │
        ▼
┌─────────────────────────────────┐
│  Cloudflare Worker (Hono)       │
│  ├─ Auth middleware             │
│  ├─ Project scope middleware    │
│  └─ User scope middleware       │
├─────────────────────────────────┤
│  Memory Classes                 │
│  ├─ ShortTermMemory             │
│  ├─ LongTermMemory              │
│  └─ ProceduralMemory            │
├─────────────────────────────────┤
│  Services                       │
│  ├─ Embeddings (Workers AI)     │
│  ├─ Vectorize (5 indexes)       │
│  ├─ Entity Resolution           │
│  └─ Cache (KV)                  │
├─────────────────────────────────┤
│  Cloudflare Bindings            │
│  ├─ D1 (SQLite — relational)    │
│  ├─ Vectorize (semantic search) │
│  ├─ KV (caching)                │
│  └─ Workers AI (embeddings)     │
└─────────────────────────────────┘
```

D1 stores all structured data (13 tables). Vectorize stores embeddings across 5 indexes (messages, entities, preferences, facts, traces), namespaced by scope tier. KV caches hot paths. Workers AI generates 768-dimension embeddings using `@cf/google/embeddinggemma-300m` (2048-token context, better MTEB scores than the older `bge-base-en-v1.5` — swap by editing `EMBEDDING_MODEL` in `wrangler.toml`).

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers Paid plan ($5/mo)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/MrSnowGlobe/cf-agent-memory.git
cd cf-agent-memory
npm install
```

### 2. Create Cloudflare resources

```bash
# Create the D1 database
npx wrangler d1 create agent-memory
# Note the database_id in the output

# Create the KV namespace
npx wrangler kv namespace create CACHE
# Note the id in the output

# Create all 5 Vectorize indexes
bash scripts/setup-vectorize.sh
```

### 3. Configure

```bash
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml` and fill in:
- `database_id` — from the D1 create output
- `id` under `[[kv_namespaces]]` — from the KV create output

Then set the bearer tokens as Wrangler **secrets** (not `[vars]` — values in `[vars]` are bundled into the Worker script and visible in the dashboard):

```bash
npx wrangler secret put AUTH_TOKEN           # bearer for all /api/* and /mcp/* routes
npx wrangler secret put ADMIN_TOKEN          # separate bearer required by /api/v1/admin/* routes
npx wrangler secret put OBSERVATORY_PASSWORD # browser-login password (optional, enables the SPA login)
```

For local development, create `.dev.vars` (already gitignored) with the same keys:

```ini
AUTH_TOKEN = "local-dev-only"
ADMIN_TOKEN = "local-dev-admin"
```

### 4. Apply database migration

```bash
npx wrangler d1 migrations apply agent-memory --remote
```

### 5. Deploy

```bash
npx wrangler deploy
```

Your memory service is now live at `https://cf-agent-memory.<your-subdomain>.workers.dev`. Verify with:

```bash
curl https://cf-agent-memory.<your-subdomain>.workers.dev/health
# {"status":"ok"}
```

## Rate Limiting

The worker ships with three Cloudflare `ratelimit` bindings (already in `wrangler.toml.example`):

| Binding | Default cap | Keyed on | Scope |
|---------|-------------|----------|-------|
| `RL_GLOBAL` | 300 req/min | `{projectId}:{userId}` | All `/api/*` and `/mcp/*` |
| `RL_AI` | 60 req/min | `{projectId}:{userId}` | POST/PUT under `/api/v1/*`, all `*/search`, and `/api/v1/context` |
| `RL_MCP` | 30 req/min | `{projectId}:{userId}:{toolName}` | Per-method on MCP `tools/call` |

The broad `RL_GLOBAL` limiter is a code-level stand-in for an edge-level Cloudflare WAF rate-limiting rule (which requires a Pro plan for header-keyed characteristics). Tune any of the three by editing the `simple = { limit = N, period = 60 }` block in `wrangler.toml` and redeploying. All three bindings are optional — the middleware is a no-op if a binding is absent, so tests and forks work without them.

Rate-limited requests receive HTTP 429 with `Retry-After: 10`.

## Local Development

```bash
npx wrangler d1 migrations apply agent-memory --local
npm run dev       # Start local dev server
npm test          # Run all tests (no Cloudflare account needed)
npm run typecheck # TypeScript strict mode check
```

Tests use Vitest with Miniflare — no Cloudflare account needed.

## MCP Integration

This is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server exposing 14 tools over both Streamable HTTP (`POST /mcp`) and SSE (`GET /mcp/sse`) transports.

### Claude Code / Claude Desktop

Add to your `.mcp.json` (or copy from `templates/.mcp.json`):

```json
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://cf-agent-memory.YOUR_SUBDOMAIN.workers.dev/mcp",
        "--header",
        "X-Project-Id: YOUR_PROJECT_NAME",
        "--header",
        "Authorization: Bearer YOUR_AUTH_TOKEN"
      ]
    }
  }
}
```

To scope memory per user, add an `X-User-Id` header:

```json
"--header",
"X-User-Id: YOUR_USER_ID"
```

### Available MCP Tools

**Short-term (conversations)**

| Tool | Description |
|------|-------------|
| `memory_create_session` | Create a short-term memory session to group messages |
| `memory_add_message` | Store a conversation message with automatic embedding |

**Long-term (knowledge)**

| Tool | Description |
|------|-------------|
| `memory_add_entity` | Add an entity with automatic 3-stage deduplication |
| `memory_add_relation` | Record a typed directed edge between two entities (graph) |
| `memory_add_preference` | Store a categorized preference |
| `memory_add_fact` | Store a temporal fact (subject-predicate-object triple) |
| `memory_traverse` | Walk the entity graph from a starting node (depth + direction) |

**Procedural (reasoning)**

| Tool | Description |
|------|-------------|
| `memory_start_trace` | Begin recording a reasoning trace |
| `memory_add_step` | Append a thought/action/observation step to an open trace |
| `memory_record_tool_call` | Record a tool call attached to a reasoning step |
| `memory_complete_trace` | Finalise a trace with outcome + success flag |

**Retrieval**

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic search across all memory types (cascading) |
| `memory_get_context` | Build a unified context string from all memory types |

**Promotion**

| Tool | Description |
|------|-------------|
| `memory_promote_to_global` | Promote a memory item to user or global scope |

### Claude Code Setup

Copy the templates into your project to enable `/remember` and `/recall` slash commands:

```bash
cp templates/CLAUDE.md your-project/CLAUDE.md
cp -r templates/.claude your-project/.claude
```

This gives your Claude Code sessions persistent memory backed by this service.

## REST API

All endpoints require `Authorization: Bearer <token>` and accept optional `X-Project-Id` (default: `"default"`) and `X-User-Id` (default: `"default"`) headers for scoping. Alternatively, a valid browser session cookie (set via `/auth/login`) is accepted for the same routes.

### Projects & Users

```
POST   /api/v1/projects                    Create (or idempotently return) a project
GET    /api/v1/projects                    List projects (?include_archived=true)
PATCH  /api/v1/projects/:id                Update display_name / archived / metadata
DELETE /api/v1/projects/:id                Delete an empty project (refuses if data exists)

POST   /api/v1/users                       Create a user
GET    /api/v1/users                       List users
```

### Sessions & Messages (Short-Term)

```
POST   /api/v1/sessions                    Create a session
GET    /api/v1/sessions                    List sessions
GET    /api/v1/sessions/:id                Get a session
DELETE /api/v1/sessions/:id                Delete a session (cascading)

POST   /api/v1/sessions/:id/messages       Add a message
GET    /api/v1/sessions/:id/messages       Get conversation
POST   /api/v1/sessions/:id/messages/batch Batch add messages
POST   /api/v1/messages/search             Semantic message search
```

### Entities, Relations & Graph (Long-Term)

```
POST   /api/v1/entities                    Add entity (with dedup)
GET    /api/v1/entities/:id                Get entity
PUT    /api/v1/entities/:id                Update entity (re-embeds on searchable-field change)
DELETE /api/v1/entities/:id                Delete entity
POST   /api/v1/entities/search             Semantic entity search

POST   /api/v1/entities/:id/relations      Add a typed relation
GET    /api/v1/entities/:id/relations      Get relations
GET    /api/v1/entities/:id/traverse       K-hop graph walk (?depth=&direction=out|in|both)
GET    /api/v1/entities/:id/subgraph       Extract the neighbourhood subgraph around an entity
```

### Preferences & Facts (Long-Term)

```
POST   /api/v1/preferences                 Add preference
GET    /api/v1/preferences                 List preferences (?category=)
PUT    /api/v1/preferences/:id             Update preference (re-embeds on change)
POST   /api/v1/preferences/search          Semantic preference search

POST   /api/v1/facts                       Add fact
GET    /api/v1/facts                       List facts (?subject=&predicate=, auto-excludes expired)
PUT    /api/v1/facts/:id                   Update fact (re-embeds on change)
POST   /api/v1/facts/search                Semantic fact search
PUT    /api/v1/facts/:id/invalidate        Soft-invalidate a fact
```

### Traces & Tool Calls (Procedural)

```
POST   /api/v1/traces                      Start a trace (embeds task on start)
GET    /api/v1/traces                      List traces (?session_id=&success=)
GET    /api/v1/traces/:id                  Get a trace
PUT    /api/v1/traces/:id/complete         Complete a trace
POST   /api/v1/traces/search               Semantic trace search

POST   /api/v1/traces/:traceId/steps       Add a reasoning step
POST   /api/v1/steps/:stepId/tool-calls    Record a tool call
GET    /api/v1/tool-stats                  Get tool usage statistics
```

### Context, Promotion & Snapshot

```
POST   /api/v1/context                     Build unified context from all memory types
POST   /api/v1/promote                     Promote an item to user or global scope
GET    /api/v1/snapshot                    Single-read bootstrap for the current scope (Observatory)
GET    /api/v1/atlas                       Cross-scope directory of every project and user
```

### Real-Time Events

```
GET    /api/v1/events                      WebSocket subscribe — per-scope DO fans out writes
```

The DO broadcasts `entity_added`, `fact_added`, `preference_added`, `message_added`, `trace_started`, and `trace_completed` events. Browser clients that can't set custom headers can pass `?project_id=<id>&user_id=<id>` as query-param fallbacks.

### Browser Auth

```
POST   /auth/login                         Exchange OBSERVATORY_PASSWORD for a signed cookie
POST   /auth/logout                        Clear the session cookie
GET    /auth/me                            Check session status
```

Cookie auth is an alternative to the bearer token for the Observatory UI. The bearer token still works for all service-to-service calls.

### Admin

```
POST   /api/v1/admin/migrate-namespaces    One-time migration for namespace scheme changes
DELETE /api/v1/admin/projects/:id/purge    Hard-purge every row, vector, and KV entry for a project
                                           (?confirm=yes required, ?delete_project=true drops the row)
```

## Example Usage

### Store and retrieve a memory via REST

```bash
BASE="https://cf-agent-memory.YOUR_SUBDOMAIN.workers.dev"
AUTH="Authorization: Bearer YOUR_TOKEN"
PROJECT="X-Project-Id: my-project"

# Create a session
curl -X POST "$BASE/api/v1/sessions" \
  -H "$AUTH" -H "$PROJECT" -H "Content-Type: application/json" \
  -d '{"id": "session-1"}'

# Add a message
curl -X POST "$BASE/api/v1/sessions/session-1/messages" \
  -H "$AUTH" -H "$PROJECT" -H "Content-Type: application/json" \
  -d '{"role": "user", "content": "Remember that our API deadline is April 30"}'

# Store as a fact
curl -X POST "$BASE/api/v1/facts" \
  -H "$AUTH" -H "$PROJECT" -H "Content-Type: application/json" \
  -d '{"subject": "API", "predicate": "deadline", "object": "2026-04-30", "valid_until": "2026-04-30"}'

# Semantic search across all memory
curl -X POST "$BASE/api/v1/messages/search" \
  -H "$AUTH" -H "$PROJECT" -H "Content-Type: application/json" \
  -d '{"query": "when is the API due?"}'
```

### Entity deduplication

```bash
# First add
curl -X POST "$BASE/api/v1/entities" \
  -H "$AUTH" -H "$PROJECT" -H "Content-Type: application/json" \
  -d '{"name": "Cloudflare Workers", "entity_type": "OBJECT", "description": "Serverless platform"}'

# Adding "Cloudflare Worker" (typo) returns the existing entity instead of creating a duplicate
curl -X POST "$BASE/api/v1/entities" \
  -H "$AUTH" -H "$PROJECT" -H "Content-Type: application/json" \
  -d '{"name": "Cloudflare Worker", "entity_type": "OBJECT"}'
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and PR guidelines.

## License

[Apache 2.0](LICENSE)
