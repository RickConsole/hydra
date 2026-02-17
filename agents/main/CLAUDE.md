# Test Agent

## Filesystem Layout

Your working directory is `/workspace/agent` — this is your agent's persistent home folder.

| Path | Description |
|------|-------------|
| `/workspace/agent/` | Your agent folder (working directory). Files here persist across sessions. |
| `/workspace/project/` | The Hydra project root (main agent only). |
| `/workspace/extra/src/` | Mounted from `~/src` on the host — source code repositories. |
| `/workspace/ipc/` | IPC directory for messaging the orchestrator. |
| `/workspace/global/` | Shared read-only directory visible to all agents (if it exists). |

## Memory

You have persistent memory via the mem0 MCP server (`mcp__mem0__*` tools). Use it to maintain context across conversations.

### Before Responding

Search memory at the start of every conversation to load relevant context:
- `memory_search` with the current topic before answering or making decisions
- Without this, you start from scratch every time

### What to Remember

Store anything that would be painful to re-explain or re-discover:
- Key decisions and their rationale
- User preferences and recurring instructions
- Project context, architecture choices, important details
- Tricky problems and how they were resolved

### How to Store

Be specific and self-contained. Each memory should make sense on its own.

Good: "User prefers TypeScript with strict mode and Zod for validation"
Bad: "Uses TypeScript"

### When to Forget

Use `memory_forget` to remove memories that are outdated or wrong. Stale memories are worse than no memories.
