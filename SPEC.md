# NanoClaw Specification

A personal Claude assistant accessible via WhatsApp, with persistent memory per conversation, scheduled tasks, and email integration.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Commands](#commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            NanoClaw                                  │
│                     (Single Node.js Process)                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │  WhatsApp    │────────────────────▶│   SQLite Database  │        │
│  │  (baileys)   │◀────────────────────│   (messages.db)    │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│                                                  ▼                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    MESSAGE LOOP                               │   │
│  │  • Polls SQLite for new messages every 2 seconds              │   │
│  │  • Filters: only registered groups, only trigger word         │   │
│  │  • Loads session ID for conversation continuity               │   │
│  │  • Invokes Claude Agent SDK in the group's directory          │   │
│  │  • Sends response back to WhatsApp                            │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                │                                     │
│                                ▼                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    CLAUDE AGENT SDK                           │   │
│  │                                                                │   │
│  │  Working directory: groups/{group-name}/                       │   │
│  │  Context loaded:                                               │   │
│  │    • ../CLAUDE.md (global memory)                              │   │
│  │    • ./CLAUDE.md (group-specific memory)                       │   │
│  │                                                                │   │
│  │  Available MCP Servers:                                        │   │
│  │    • gmail-mcp (read/send email)                               │   │
│  │    • schedule-task-mcp (create cron jobs)                      │   │
│  │                                                                │   │
│  │  Built-in Tools:                                               │   │
│  │    • WebSearch, WebFetch (internet access)                     │   │
│  │    • Read, Write, Edit (file operations in group folder)       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| WhatsApp Connection | Node.js (@whiskeysockets/baileys) | Connect to WhatsApp, send/receive messages |
| Message Storage | SQLite (better-sqlite3) | Store messages for polling |
| Agent | @anthropic-ai/claude-agent-sdk | Run Claude with tools and MCP servers |
| Runtime | Node.js 18+ | Single unified process |

---

## Folder Structure

```
nanoclaw/
├── CLAUDE.md                      # Project context for Claude Code
├── SPEC.md                        # This specification document
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
├── .gitignore
│
├── src/
│   └── index.ts                   # Main application (WhatsApp + routing + agent)
│
├── dist/                          # Compiled JavaScript (gitignored)
│   └── index.js
│
├── .claude/
│   └── skills/
│       ├── setup/
│       │   └── SKILL.md           # /setup skill
│       └── customize/
│           └── SKILL.md           # /customize skill
│
├── groups/
│   ├── CLAUDE.md                  # Global memory (all groups read this)
│   ├── main/                      # Self-chat (main control channel)
│   │   ├── CLAUDE.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {Group Name}/              # Per-group folders (created on registration)
│       ├── CLAUDE.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   ├── auth/                      # WhatsApp authentication state
│   └── messages.db                # SQLite message database
│
├── data/                          # Application state (gitignored)
│   ├── sessions.json              # Active session IDs per group
│   ├── archived_sessions.json     # Old sessions after /clear
│   ├── registered_groups.json     # Group JID → folder mapping
│   └── router_state.json          # Last processed timestamp
│
├── logs/                          # Runtime logs (gitignored)
│   ├── nanoclaw.log               # stdout
│   └── nanoclaw.error.log         # stderr
│
└── launchd/
    └── com.nanoclaw.plist         # macOS service configuration
```

---

## Configuration

Configuration is done via environment variables and the CONFIG object in `src/index.ts`:

```typescript
const CONFIG = {
  assistantName: process.env.ASSISTANT_NAME || 'Andy',
  pollInterval: 2000, // ms
  storeDir: './store',
  groupsDir: './groups',
  dataDir: './data',
};
```

### Changing the Assistant Name

Set the `ASSISTANT_NAME` environment variable:

```bash
ASSISTANT_NAME=Bot npm start
```

Or edit the default in `src/index.ts`. This changes:
- The trigger pattern (messages must start with `@YourName`)
- The response prefix (`YourName:`)

### Placeholder Values in launchd

Files with `{{PLACEHOLDER}}` values need to be configured:
- `{{PROJECT_ROOT}}` - Absolute path to your nanoclaw installation
- `{{NODE_PATH}}` - Path to node binary (detected via `which node`)
- `{{HOME}}` - User's home directory

---

## Memory System

NanoClaw uses a hierarchical memory system based on CLAUDE.md files.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/CLAUDE.md` | All groups | Main only | Preferences, facts, context shared across all conversations |
| **Group** | `groups/{name}/CLAUDE.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - Claude Agent SDK with `settingSources: ['project']` automatically loads:
     - `../CLAUDE.md` (parent directory = global memory)
     - `./CLAUDE.md` (current directory = group memory)

2. **Writing Memory**
   - When user says "remember this", agent writes to `./CLAUDE.md`
   - When user says "remember this globally" (main channel only), agent writes to `../CLAUDE.md`
   - Agent can create files like `notes.md`, `research.md` in the group folder

3. **Main Channel Privileges**
   - Only the "main" group (self-chat) can write to global memory
   - This prevents other groups from modifying shared context

---

## Session Management

Sessions enable conversation continuity - Claude remembers what you talked about.

### How Sessions Work

1. Each group has a session ID stored in `data/sessions.json`
2. Session ID is passed to Claude Agent SDK's `resume` option
3. Claude continues the conversation with full context

**data/sessions.json:**
```json
{
  "main": "session-abc123",
  "Family Chat": "session-def456"
}
```

### The /clear Command

When a user sends `/clear` in any group:

1. Current session ID is moved to `data/archived_sessions.json`
2. Session ID is removed from `data/sessions.json`
3. Next message starts a fresh session
4. **Memory files are NOT deleted** - only the session resets

---

## Message Flow

### Incoming Message Flow

```
1. User sends WhatsApp message
   │
   ▼
2. Baileys receives message via WhatsApp Web protocol
   │
   ▼
3. Message stored in SQLite (store/messages.db)
   │
   ▼
4. Message loop polls SQLite (every 2 seconds)
   │
   ▼
5. Router checks:
   ├── Is chat_jid in registered_groups.json? → No: ignore
   ├── Does message start with @Assistant? → No: ignore
   └── Is message "/clear"? → Yes: handle specially
   │
   ▼
6. Router prepares invocation:
   ├── Load session ID for this group
   ├── Determine group folder path
   └── Strip trigger word from message
   │
   ▼
7. Router invokes Claude Agent SDK:
   ├── cwd: groups/{group-name}/
   ├── prompt: user's message
   ├── resume: session_id (or undefined)
   └── mcpServers: gmail, scheduler
   │
   ▼
8. Claude processes message:
   ├── Reads CLAUDE.md files for context
   └── Uses tools as needed (search, email, etc.)
   │
   ▼
9. Router captures result and sends via WhatsApp
   │
   ▼
10. Router saves new session ID
```

### Trigger Word Matching

Messages must start with the trigger pattern (default: `@Andy`):
- `@Andy what's the weather?` → ✅ Triggers Claude
- `@andy help me` → ✅ Triggers (case insensitive)
- `Hey @Andy` → ❌ Ignored (trigger not at start)
- `What's up?` → ❌ Ignored (no trigger)
- `/clear` → ✅ Special command (no trigger needed)

---

## Commands

### Commands Available in Any Group

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant [message]` | `@Andy what's the weather?` | Talk to Claude |
| `/clear` | `/clear` | Reset session, keep memory |

### Commands Available in Main Channel Only

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant add group "Name"` | `@Andy add group "Family Chat"` | Register a new group |
| `@Assistant remove group "Name"` | `@Andy remove group "Work Team"` | Unregister a group |
| `@Assistant list groups` | `@Andy list groups` | Show registered groups |
| `@Assistant remember [fact]` | `@Andy remember I prefer dark mode` | Add to global memory |

---

## Scheduled Tasks

NanoClaw can schedule recurring tasks that run at specified times via the scheduler MCP.

### Creating a Task

```
User: @Andy remind me every Monday at 9am to review the weekly metrics

Claude: [calls mcp__scheduler__create_task]
        {
          "instruction": "Remind user to review weekly metrics",
          "trigger_type": "cron",
          "cron_expression": "0 9 * * 1"
        }

Claude: Done! I'll remind you every Monday at 9am.
```

---

## MCP Servers

MCP servers are configured in the Claude Agent SDK options:

```typescript
mcpServers: {
  gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
  scheduler: { command: 'npx', args: ['-y', 'schedule-task-mcp'] }
}
```

### Gmail MCP (@gongrzhe/server-gmail-autoauth-mcp)

Provides email capabilities. Requires Google Cloud OAuth setup.

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `search_messages` | Search inbox |
| `get_message` | Read full email |
| `send_message` | Send email |
| `reply_message` | Reply to thread |

### Scheduler MCP (schedule-task-mcp)

Provides cron-style task scheduling.

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `create_task` | Schedule a new task |
| `list_tasks` | Show scheduled tasks |
| `delete_task` | Cancel a task |
| `update_task` | Modify schedule |

---

## Deployment

NanoClaw runs as a single macOS launchd service.

### Service: com.nanoclaw

**launchd/com.nanoclaw.plist:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{PROJECT_ROOT}}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>ASSISTANT_NAME</key>
        <string>Andy</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/nanoclaw.error.log</string>
</dict>
</plist>
```

### Managing the Service

```bash
# Install service
cp launchd/com.nanoclaw.plist ~/Library/LaunchAgents/

# Start service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist

# Check status
launchctl list | grep nanoclaw

# View logs
tail -f logs/nanoclaw.log
```

---

## Security Considerations

### Prompt Injection Risk

WhatsApp messages could contain malicious instructions attempting to manipulate Claude's behavior.

**Mitigations:**
- Only registered groups are processed
- Trigger word required (reduces accidental processing)
- Main channel has elevated privileges (isolated from other groups)
- Claude's built-in safety training

**Recommendations:**
- Only register trusted groups
- Review scheduled tasks periodically
- Monitor logs for unusual activity

### Credential Storage

| Credential | Storage Location | Notes |
|------------|------------------|-------|
| Claude CLI Auth | ~/.claude/ | Managed by Claude Code CLI |
| WhatsApp Session | store/auth/ | Auto-created, persists ~20 days |
| Gmail OAuth Tokens | ~/.gmail-mcp/ | Created during setup (optional) |

### File Permissions

The groups/ folder contains personal memory and should be protected:
```bash
chmod 700 groups/
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list | grep nanoclaw` |
| "QR code expired" | WhatsApp session expired | Delete store/auth/ and restart |
| "No groups registered" | Haven't added groups | Use `@Andy add group "Name"` in main |
| Session not continuing | Session ID not saved | Check `data/sessions.json` |

### Log Location

- `logs/nanoclaw.log` - stdout
- `logs/nanoclaw.error.log` - stderr

### Debug Mode

Run manually for verbose output:
```bash
npm run dev
# or
node dist/index.js
```
