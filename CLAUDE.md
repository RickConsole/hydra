# NanoClaw

Personal Claude assistant via WhatsApp.

## Structure

- `src/index.ts` - Main application (WhatsApp + routing + agent)
- `package.json` - Dependencies and scripts
- `.mcp.json` - MCP server configuration (gmail, scheduler)
- `groups/CLAUDE.md` - Global memory
- `groups/{name}/CLAUDE.md` - Per-group memory

## Configuration

Set environment variable `ASSISTANT_NAME` to change the trigger (default: "Andy").

Or edit the CONFIG object in `src/index.ts`.

## Skills

- `/setup` - Install dependencies, authenticate, start services
- `/customize` - Modify behavior

## Architecture

```
WhatsApp (baileys) ─┬─> SQLite (messages.db)
                    │           ↓
                    │   Polling loop
                    │           ↓
                    │   Claude Agent SDK
                    │           ↓
                    └─< Send response
```

Single Node.js process handles everything.
