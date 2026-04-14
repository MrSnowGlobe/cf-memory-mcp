# Memory

This project has a persistent memory system via MCP. You MUST use it — do not skip, approximate, or respond from conversation context alone.

## Rules

1. **When the user says /remember, /recall, "remember", "save", "store", "recall", "what do you know about"**: You MUST call the corresponding MCP memory tool. Do NOT respond without making the tool call first. Do NOT paraphrase or summarize from conversation — call the tool.

2. **When starting a complex task**: Call `memory_get_context` FIRST to retrieve relevant context before proceeding. Do not skip this step.

3. **When you learn something worth persisting** (user preferences, project facts, key entities, decisions): Call the appropriate memory tool to store it. Do not wait to be asked.

4. **If an MCP tool call fails**: Tell the user explicitly that the memory tool failed and why. Do not silently fall back to responding without memory.

## Tools

| Trigger | Tool to call | Never skip |
|---------|-------------|------------|
| /remember, "remember this", "save" | `memory_add_entity`, `memory_add_preference`, or `memory_add_fact` | MUST call before responding |
| /recall, "what do you know", "recall" | `memory_search` or `memory_get_context` | MUST call before responding |
| Starting a complex task | `memory_get_context` | MUST call before starting work |
| "promote" | `memory_promote_to_global` | MUST call before responding |

## Slash Commands

- `/remember <what>` — Store knowledge in long-term memory
- `/recall <query>` — Search and retrieve stored memories
