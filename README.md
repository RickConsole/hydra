<p align="center">
  <img src="assets/hydra-logo.png" alt="Hydra" width="400">
</p>

<p align="center">
  <strong>Secure AI agents that run in containers.</strong><br>
  One config file. Real isolation. Full control.
</p>

---

## What Makes Hydra Different

Most AI agent frameworks run everything in a single process with application-level permission checks. If the agent can execute code, it can access anything the process can access. Security is an afterthought.

**Hydra agents run in actual Linux containers.** Each agent is isolated at the OS level. They can only see what you explicitly mount. Bash commands execute inside the container, not on your host. This isn't a permission system—it's real sandboxing.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your Machine                            │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Hydra Orchestrator                      │  │
│  │  • Routes messages from Telegram/Web/Voice/SMS            │  │
│  │  • Manages agent lifecycle and sessions                   │  │
│  │  • Exposes API for Hydra Console                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│           │              │              │              │        │
│           ▼              ▼              ▼              ▼        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐           │
│  │  Container   │ │  Container   │ │  Container   │  ...      │
│  │  ┌────────┐  │ │  ┌────────┐  │ │  ┌────────┐  │           │
│  │  │ Claude │  │ │  │ Claude │  │ │  │ Claude │  │           │
│  │  │ Agent  │  │ │  │ Agent  │  │ │  │ Agent  │  │           │
│  │  └────────┘  │ │  └────────┘  │ │  └────────┘  │           │
│  │              │ │              │ │              │           │
│  │  /workspace/ │ │  /workspace/ │ │  /workspace/ │           │
│  │  └─ group/   │ │  └─ group/   │ │  └─ group/   │           │
│  │     (only    │ │     (only    │ │     (only    │           │
│  │     its own) │ │     its own) │ │     its own) │           │
│  └──────────────┘ └──────────────┘ └──────────────┘           │
│       main            dev            family                    │
└─────────────────────────────────────────────────────────────────┘
```

**Other key differences:**

| | Typical Agent Framework | Hydra |
|---|---|---|
| **Security model** | Permission checks in code | OS-level container isolation |
| **Bash commands** | Run on host | Run in container |
| **File access** | Allowlists/blocklists | Only mounted paths exist |
| **Agent isolation** | Shared memory, one process | Separate containers |
| **Configuration** | Multiple files, env vars | Single `hydra.yaml` |
| **Runtime** | Claude API wrapper | Claude Agent SDK (Claude Code) |

## How It Works

1. **Messages arrive** via Telegram, Web Console, Voice, or SMS
2. **Orchestrator routes** the message to the right agent based on chat ID
3. **Container spawns** with only that agent's folder mounted
4. **Claude Agent SDK runs** inside the container with full tool access
5. **Response returns** through the orchestrator to the original channel
6. **Container exits** — no persistent processes, no state leakage

Each agent has its own:
- `CLAUDE.md` file (persistent memory/instructions)
- Session state (conversation context)
- Filesystem (isolated from other agents)
- IPC namespace (can't send messages as other agents)

## Quick Start

```bash
git clone https://github.com/RickConsole/hydra.git
cd hydra
npm install
cp config-examples/hydra.yaml ./hydra.yaml
# Edit hydra.yaml with your bot tokens and agent config
npm run dev
```

## Configuration

Everything lives in one file: `hydra.yaml`

```yaml
version: "1"
project: my-assistant

# Bots (communication channels)
bots:
  merlin:
    name: Merlin
    token: env:TELEGRAM_BOT_TOKEN  # References .env variable
    platform: telegram

# Agents (each runs in its own container)
agents:
  - name: Main Assistant
    folder: main
    trigger: "@Merlin"
    bot: merlin
    chat_id: "-1001234567890"

  - name: Dev Helper
    folder: dev
    trigger: "@Dev"
    bot: merlin
    chat_id: "-1009876543210"
    container:
      image: hydra-agent:custom
      timeout: 600000
      mounts:
        - host_path: ~/projects
          container_path: src
          readonly: false

# Security (mount allowlist lives separately for tamper-proofing)
security:
  mounts:
    non_main_readonly: true
    blocked_patterns:
      - .ssh
      - .gnupg
      - password
      - secret

# Optional integrations
voice:
  enabled: true
  port: 3340
  group: main

memory:
  provider: mem0
  endpoint: http://localhost:8080
```

### Environment Variables

Sensitive values use `env:VAR_NAME` syntax:

```yaml
token: env:TELEGRAM_BOT_TOKEN
```

Create a `.env` file:

```
TELEGRAM_BOT_TOKEN=123456:ABC...
ANTHROPIC_API_KEY=sk-ant-...
```

### Mount Security

The mount allowlist lives separately at `~/.config/hydra/mount-allowlist.json` — outside the container's reach. Even if an agent modifies `hydra.yaml`, it can't add mounts that aren't pre-approved.

## Hydra Console (Web UI)

Hydra includes a Next.js web interface for managing agents without Telegram:

```bash
cd hydra-console
npm install
npm run dev
# Open http://localhost:3000
```

**Features:**
- 💬 Chat with any agent
- 🤖 View agent status and logs
- ⚙️ Edit `hydra.yaml` with validation
- 🧠 Browse agent memories
- 📜 Real-time log streaming

The console connects to the orchestrator's API (default port 3340).

## Architecture

```
hydra/
├── src/
│   ├── index.ts           # Orchestrator: routing, IPC, lifecycle
│   ├── container-runner.ts # Spawns agent containers
│   ├── task-scheduler.ts   # Scheduled/recurring tasks
│   ├── hydra-config.ts     # Unified config loader
│   ├── api/                # HTTP + WebSocket API for console
│   └── db.ts               # SQLite for tasks, chat metadata
├── groups/
│   ├── main/              # Main agent's workspace
│   │   └── CLAUDE.md      # Persistent memory
│   └── dev/               # Dev agent's workspace
│       └── CLAUDE.md
├── hydra-console/         # Next.js web UI
├── hydra.yaml             # Single config file
└── data/                  # Sessions, IPC, database
```

### Key Components

**Orchestrator** (`src/index.ts`)
- Connects to Telegram bots
- Routes incoming messages to agents
- Manages sessions and state
- Processes IPC from containers (scheduled tasks, send_message)

**Container Runner** (`src/container-runner.ts`)
- Builds volume mounts based on agent config
- Spawns Docker or Apple Container
- Captures output, handles timeouts
- Syncs credentials for Claude auth

**API Server** (`src/api/`)
- REST endpoints for config, agents, chat, memory, logs
- WebSocket for real-time updates
- Powers the Hydra Console

## Supported Channels

- **Telegram** — Primary channel, supports images and PDFs
- **Web Console** — Built-in web UI for local use
- **Voice** — Twilio + ElevenLabs integration
- **SMS** — Via Twilio (shares voice webhook)

## Requirements

- Node.js 20+
- Docker or Apple Container (macOS)
- Telegram bot token (for Telegram channel)
- Anthropic API key or Claude Code OAuth

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | For Telegram | Bot token from @BotFather |
| `ANTHROPIC_API_KEY` | One of these | API key for Claude |
| `CLAUDE_CODE_OAUTH_TOKEN` | One of these | OAuth token from Claude Code |
| `HYDRA_API_PORT` | No | API server port (default: 3340) |
| `HYDRA_API_ENABLED` | No | Set to `false` to disable API |

## Security Model

1. **Container isolation** — Each agent runs in a separate container
2. **Explicit mounts** — Agents can only see mounted directories
3. **IPC namespacing** — Agents can only send messages to their own chats
4. **External allowlist** — Mount permissions live outside agent reach
5. **Main privilege** — Only the `main` agent can register new groups

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

## Contributing

Hydra is designed to be small enough to understand and modify. PRs welcome for:

- Security fixes
- Bug fixes
- Clear improvements to core functionality

For new features, consider whether they belong in core or as optional extensions.

## License

AGPL-3.0 (inherits from Wardgate integration)
