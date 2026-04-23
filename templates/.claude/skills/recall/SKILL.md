---
name: recall
description: Retrieve knowledge from memory. Use when the user says "recall", "what do you know about", "remember when", or when context from past sessions would help the current task.
---

# /recall — Retrieve Knowledge

**MANDATORY**: You MUST call an MCP memory tool below. Do NOT respond without making the tool call first. Do NOT answer from conversation context or guess — call the tool and use its results.

## When invoked with arguments

Use `$ARGUMENTS` as the search query.

1. You MUST call `memory_search` with:
   - `query`: the search terms from `$ARGUMENTS`
   - `types`: search all types unless the user specifies (e.g., "recall facts about X" -> types: ["facts"])
   - `limit`: 10 (default)

2. Present results grouped by type:
   - **Entities**: Name, type, description
   - **Preferences**: Category, preference, context
   - **Facts**: Subject-predicate-object, note if time-bounded
   - **Messages**: Content snippet with session info
   - **Traces**: Task, outcome, success/failure

3. If no results are found, say so explicitly. Do NOT fabricate results.

## When invoked without arguments (or as "context")

You MUST call `memory_get_context` with:
- `query`: a summary of what you're currently working on (infer from conversation)
- `session_id`: current session if available
- `include`: all three types (short_term, long_term, procedural)

This returns a formatted context block. Use it to inform your next response.

## Graph queries

When the user asks how two things are connected ("how does Alice know Bob", "what's connected to the auth service"), prefer `memory_traverse` over `memory_search`:

- `entity_id`: the starting node
- `max_depth`: hops to walk (1–4, default 2)
- `direction`: "out" (outgoing edges), "in" (incoming), or "both" (default)

Use the resulting edges + nodes to explain the path. Fall back to `memory_search` if no traversal path exists.

## IMPORTANT

- You MUST call the MCP tool before responding. No exceptions.
- If the tool call fails, tell the user explicitly that memory retrieval failed.
- Do NOT guess, approximate, or respond from conversation history instead of calling the tool.
- If results seem thin, try broader search terms before giving up.
- Project-scoped results are ranked higher than global results automatically.
- Expired facts are filtered out automatically.
