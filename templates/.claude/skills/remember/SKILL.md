---
name: remember
description: Store knowledge in long-term memory. Use when the user says "remember", "save", "store", or when you learn something worth persisting (entities, preferences, facts).
---

# /remember — Store Knowledge

**MANDATORY**: You MUST call an MCP memory tool below. Do NOT respond without making the tool call first. Do NOT skip the tool call and respond from conversation context.

## When invoked with arguments

Parse `$ARGUMENTS` and determine the best memory type, then call the corresponding tool:

### Entity (a person, place, thing, org, event)
You MUST call `memory_add_entity` with:
- `name`: the entity name
- `entity_type`: one of PERSON, OBJECT, LOCATION, EVENT, ORGANIZATION, CUSTOM
- `description`: what you know about it

Examples: "Remember Alice is the lead developer" -> PERSON. "Remember we use Cloudflare Workers" -> OBJECT.

### Preference (a stated preference, opinion, or choice)
You MUST call `memory_add_preference` with:
- `category`: topic area (tools, code-style, communication, food, etc.)
- `preference`: the preference statement
- `context`: when this applies (optional)

Examples: "Remember I prefer Hono over itty-router" -> category: tools. "Remember to always use strict TypeScript" -> category: code-style.

### Fact (a factual statement, possibly temporal)
You MUST call `memory_add_fact` with:
- `subject`: who/what
- `predicate`: relationship (works_on, lives_in, uses, etc.)
- `object`: the value
- `valid_from` / `valid_until`: if the fact is time-bounded (optional)

Examples: "Remember the API deadline is April 30" -> subject: API, predicate: deadline, object: 2026-04-30, valid_until: 2026-04-30. "Remember the DB password was rotated" -> time-stamped fact.

### Relation (a typed edge between two existing entities)
Use this when the knowledge is "Entity A <verb> Entity B" and you want it traversable as a graph later (e.g. `memory_traverse` from Alice finds Bob). Prefer a relation when the claim connects two *named things* you already track; prefer a fact when the object is a value, date, or free-form string.

You MUST:
1. Resolve both entities first — call `memory_add_entity` for each side (resolution dedupes; existing entities are returned rather than recreated). Capture the returned `id` for source and target.
2. Call `memory_add_relation` with:
   - `source_entity_id`: the returned id from step 1
   - `target_entity_id`: the returned id from step 1
   - `relation_type`: a short verb phrase (knows, works_at, reports_to, owns, acquired, located_in, etc.)
   - `relation_strength`: optional 0–1 weight (default 1.0)

Examples: "Remember Alice knows Bob" -> two entity resolves + relation knows. "Remember Cloudflare acquired Workers Launchpad" -> two entity resolves + relation acquired.

## When invoked without arguments

Ask the user what they want to remember.

## After storing

Confirm what was stored and the memory type chosen. If the knowledge seems useful across all projects, suggest promoting to user or global scope.

## Promote subcommand

If `$ARGUMENTS` starts with "promote", you MUST call `memory_promote_to_global` with the type, id, and reason. Use target "user" for cross-project personal knowledge, or "global" for knowledge all users should see.

## IMPORTANT

If the MCP tool call fails or is unavailable, tell the user explicitly. Do NOT pretend the memory was stored. Do NOT silently skip the tool call.
