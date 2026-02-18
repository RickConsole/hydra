---
name: setup
description: Run initial Hydra setup. Use when user wants to install dependencies, create hydra.yaml, configure services, or do first-time setup. Triggers on "setup", "install", "configure hydra", or first-time setup requests. For creating agents after initial setup, use /add-agent instead.
---

# Hydra Setup

Run all commands automatically. Only pause when user action is required (pasting tokens, choosing options).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

**Resume awareness:** Before starting, check what's already done:
- `hydra.yaml` exists? Skip config creation or offer to modify it.
- `.env` exists with keys? Skip auth setup.
- `docker images | grep hydra-agent` returns results? Skip container build.
- `agents/` has folders? Skip agent creation or offer to add more.

---

## 1. Install Dependencies & Build

```bash
npm install && npm run build && npm link
```

Verify the CLI is available:
```bash
hydra --help
```

If `hydra --help` fails, the `npm link` may need `sudo` or the user's npm prefix is misconfigured. Suggest:
```bash
sudo npm link
```

## 2. Configure Authentication

Check if `.env` already exists:
```bash
[ -f .env ] && cat .env | grep -E "^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=" | sed 's/=.*/=***/' || echo "No .env file found"
```

If already configured, confirm with the user and skip ahead.

Ask the user:
> How do you want to authenticate with Claude?

Options:
1. **Claude subscription** (Pro/Max) - uses OAuth token
2. **Anthropic API key** - uses API key directly

### Option 1: Claude Subscription

Tell the user:
> Open another terminal and run:
> ```
> claude setup-token
> ```
> A browser window will open. Once authenticated, paste the token here.

When they provide the token, write it to `.env`:
```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" >> .env
```

### Option 2: API Key

Ask if they have an existing key or need to create one at https://console.anthropic.com/

```bash
echo "ANTHROPIC_API_KEY=<key>" >> .env
```

Verify:
```bash
grep -E "^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=" .env | sed 's/=.\{10\}/=***/;s/\(.\{20\}\).*/\1.../' && echo "Auth configured"
```

## 3. Build Container Image

Check Docker is running:
```bash
docker info >/dev/null 2>&1 && echo "Docker is running" || echo "ERROR: Docker is not running. Install and start Docker first."
```

If Docker is not available, **stop and tell the user to install Docker before continuing.**

Build:
```bash
./container/build.sh
```

Verify:
```bash
docker images | grep hydra-agent
```

## 4. Create hydra.yaml

This is the core configuration step. The config file controls everything: agents, bots, security, and memory.

**If `hydra.yaml` already exists**, ask:
> You already have a hydra.yaml. Do you want to:
> 1. Keep it and skip to agent creation
> 2. Start fresh with a new config
> 3. Review and modify the existing config

**If starting fresh**, build the config interactively by collecting answers first, then writing the file in one shot.

### 4a. Collect Configuration

Ask these questions in order, using `AskUserQuestion` for each:

**Project name:**
> What do you want to name this Hydra instance? (e.g., "my-setup", "home-lab")
> This is just for identification.

**Telegram integration:**
> Do you want to connect agents to Telegram?
> This lets you message agents from your phone. You can always add this later.

If **yes**:
> Do you already have a Telegram bot token, or need to create one?

If they need to create one, tell them:
> 1. Open Telegram and message @BotFather
> 2. Send `/newbot` and follow the prompts
> 3. Copy the bot token (looks like `123456:ABC-DEF...`)
> 4. Paste it here

Add token to `.env`:
```bash
echo "TELEGRAM_BOT_TOKEN=<token>" >> .env
```

Ask:
> What name does the bot use? (This becomes the trigger word, e.g., "@Anton")

**External directory access:**
> Do you want agents to access directories **outside** the Hydra project?
>
> Examples: Git repos (`~/src`), project folders, documents.
> Without this, agents can only access their own agent folder.

If **yes**:
> Which directories? List parent folders (e.g., `~/src`) or specific paths.

For each directory:
> Should `[directory]` be **read-write** or **read-only**?

> Should non-main agents be restricted to **read-only** even for read-write directories? (Recommended: yes)

**IMPORTANT: Two files control mount access.** Both must be configured:
1. `hydra.yaml` `security:` section — defines the policy in the project config
2. `~/.config/hydra/mount-allowlist.json` — external allowlist read at runtime by the mount security module

If the allowlist file doesn't exist, **ALL additional mounts are blocked** regardless of what's in hydra.yaml. The allowlist lives outside the project so agents can't tamper with it.

Store the user's answers — you'll use them to write both files.

**Long-term memory:**
> Do you want to set up long-term memory for agents?
>
> 1. **Skip** - no persistent memory across sessions
> 2. **mem0 Cloud** - hosted service (requires API key from mem0.ai)
> 3. **Self-hosted** - Qdrant + Ollama via Docker Compose (started by `hydra up`)

If **mem0 Cloud**: add key to `.env`:
```bash
echo "MEM0_API_KEY=<key>" >> .env
```

### 4b. Write the Config File

Assemble `hydra.yaml` based on collected answers. **Do NOT include an `agents:` section** — agents will be added by `hydra agent create` in the next step.

**Rules:**
- Omit entire sections that aren't needed (no empty `bots:`, `memory:`, or `security:`)
- Use `env:VAR_NAME` syntax for secrets — never inline tokens
- Always include `version: "1"` and `runtime:` with defaults

**Template (include only relevant sections):**

```yaml
version: "1"
project: <PROJECT_NAME>

# Only include if user wants Telegram
bots:
  <bot_key>:
    name: <BotName>
    token: env:TELEGRAM_BOT_TOKEN
    platform: telegram

# Only include if user wants external directory access
security:
  mounts:
    allowed_roots:
      - path: <~/path>
        allow_read_write: <true|false>
        description: <what this is>
    blocked_patterns:
      - .ssh
      - .gnupg
      - .aws
      - credentials
    non_main_readonly: true

# Only include if user chose mem0
memory:
  provider: mem0
  self_hosted: false          # true for self-hosted
  api_key: env:MEM0_API_KEY   # omit for self-hosted
  # For self-hosted, include instead:
  # qdrant_url: http://localhost:6333
  # ollama_url: http://localhost:11434

# Always include
runtime:
  log_level: info
```

Write the assembled config using the Write tool (not bash heredoc — YAML indentation is fragile).

### 4c. Create Mount Allowlist (if external dirs configured)

If the user configured external directory access, create the runtime allowlist file. **This file must exist or all mounts will be rejected.**

```bash
mkdir -p ~/.config/hydra
```

Write `~/.config/hydra/mount-allowlist.json` using the Write tool. The format uses camelCase (different from hydra.yaml's snake_case):

```json
{
  "allowedRoots": [
    {
      "path": "~/src",
      "allowReadWrite": true,
      "description": "Source code repositories"
    }
  ],
  "blockedPatterns": [
    ".ssh", ".gnupg", ".aws", "credentials", ".env",
    ".netrc", ".npmrc", "id_rsa", "id_ed25519", "private_key", ".secret"
  ],
  "nonMainReadOnly": true
}
```

**Rules for the allowlist file:**
- `allowedRoots` entries must cover every `host_path` used in agent mounts. A mount at `~/src/myproject` requires a root at `~/src` or `~/src/myproject`.
- `blockedPatterns` are always merged with built-in defaults (`.ssh`, `.gnupg`, etc.) but it's good practice to list them explicitly.
- `nonMainReadOnly: true` forces non-main agents to read-only even if `allowReadWrite` is true on the root.
- The `security:` section in `hydra.yaml` and this file should define the **same roots** — hydra.yaml is for config validation, this file is for runtime enforcement.

If the user does NOT want external directory access, still create an empty allowlist so the system doesn't log warnings:

```bash
mkdir -p ~/.config/hydra
```

```json
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

### 4d. Validate

```bash
hydra config validate
```

If validation fails, read the error and fix the config. Common issues:
- Bot referenced in agent doesn't exist in `bots:` section
- Duplicate agent folders
- Invalid folder names (must be `^[a-z0-9_-]+$`)
- Missing `version: "1"`

## 5. Create First Agent

Create a basic first agent to get started. `hydra agent create` creates `agents/<folder>/CLAUDE.md` and appends a basic entry to `hydra.yaml`.

Ask:
> What should your first agent be called?
>
> **Name:** Display name (e.g., "Main Assistant", "Dev Helper")
> **Folder:** Short lowercase identifier (e.g., "main", "dev")

Folder must match `^[a-z0-9_-]+$`.

```bash
hydra agent create --name "<AGENT_NAME>" --folder <AGENT_FOLDER>
```

If the user set up Telegram in step 4, **edit hydra.yaml** to add `trigger`, `bot`, and `chat_id` to the agent entry:

```yaml
agents:
  - name: <AGENT_NAME>
    folder: <AGENT_FOLDER>
    trigger: "@<BotName>"     # Add this
    bot: <bot_key>            # Add this
    chat_id: ""               # Add this — auto-populated when user messages the bot
```

If the user configured external mounts in step 4, also add the `container:` block:

```yaml
    container:
      mounts:
        - host_path: <~/path>
          container_path: <name>
          readonly: false
```

Validate:
```bash
hydra config validate
```

Tell the user:
> Your first agent is ready! To customize its persona, add more mounts, or create additional agents, use `/add-agent`.

## 6. Test with Interactive CLI

```bash
hydra exec <AGENT_FOLDER>
```

Tell the user:
> This drops you into a live Claude Code session inside the agent's container.
> Type a message to test. Exit with `/exit` or Ctrl+C.

**If this works, core setup is complete.** Everything below is optional.

---

## Optional: Background Orchestrator

The orchestrator enables Telegram message listening, task scheduling, and IPC routing. Without it, agents are only available via `hydra exec`.

Ask:
> Do you want to start the background orchestrator?

```bash
hydra up
```

Verify:
```bash
hydra status
```

To stop:
```bash
hydra down
```

### Auto-Start on Boot

Ask:
> Want Hydra to start automatically on boot?

Detect platform:
```bash
uname -s
```

#### Linux (systemd)

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/hydra.service << EOF
[Unit]
Description=Hydra Agent Orchestrator
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=${PROJECT_PATH}
ExecStart=${NODE_PATH} ${PROJECT_PATH}/dist/index.js
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable hydra
systemctl --user start hydra
```

Verify:
```bash
systemctl --user status hydra
```

#### macOS (launchd)

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

mkdir -p ~/Library/LaunchAgents logs
cat > ~/Library/LaunchAgents/com.hydra.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hydra</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/hydra.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/hydra.error.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.hydra.plist
```

Verify:
```bash
launchctl list | grep hydra
```

---

## Troubleshooting

**`hydra exec` fails or hangs:**
- Verify image exists: `docker images | grep hydra-agent`
- Rebuild: `./container/build.sh`
- Check Docker is running: `docker info`

**Container agent errors:**
- Check logs: `cat agents/<folder>/logs/container-*.log | tail -50`
- Run with verbose output: `hydra exec <folder> --verbose`

**Config validation fails:**
- Run `hydra config validate` and read the error carefully
- Check YAML syntax (indentation matters!)
- Ensure all `env:VAR_NAME` references exist in `.env`

**Orchestrator not starting:**
- Debug mode: `hydra up --foreground`
- Check logs: `hydra logs`
- Linux: `journalctl --user -u hydra -f`
- macOS: `cat logs/hydra.error.log`

**Telegram bot not responding:**
- Verify trigger matches (must start with `@BotName`)
- Confirm orchestrator is running: `hydra status`
- Check `chat_id` is populated in `hydra.yaml` (send a message to the bot first)
- Check logs: `hydra logs | grep telegram`
