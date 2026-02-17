---
name: setup
description: Run initial Hydra setup. Use when user wants to install dependencies, configure channels (Telegram, CLI), or start the background services. Triggers on "setup", "install", "configure hydra", or first-time setup requests.
---

# Hydra Setup

Run all commands automatically. Only pause when user action is required.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## 1. Install Dependencies

```bash
npm install
npm run build
npm link
```

The `npm link` step makes the `hydra` CLI command available globally.

Verify:
```bash
hydra --help
```

## 2. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, add it to `.env`:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

### Option 2: API Key

Ask if they have an existing key to copy or need to create one.

**Copy existing:**
```bash
grep "^ANTHROPIC_API_KEY=" /path/to/source/.env > .env
```

**Create new:**
```bash
echo 'ANTHROPIC_API_KEY=' > .env
```

Tell the user to add their key from https://console.anthropic.com/

**Verify:**
```bash
KEY=$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:10}...${KEY: -4}" || echo "Missing"
```

## 3. Build Container Image

Check that Docker is installed and running:

```bash
docker info >/dev/null 2>&1 && echo "Docker is running" || echo "Docker is NOT running - please install and start Docker first"
```

If Docker is not available, tell the user to install it before continuing.

Build the Hydra agent container:

```bash
./container/build.sh
```

This creates the `hydra-agent:latest` image with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify:
```bash
echo '{}' | docker run -i --rm --entrypoint /bin/echo hydra-agent:latest "Container OK" || echo "Container build failed"
```

## 4. Create Your First Agent

```bash
hydra agent create
```

This will interactively ask for an agent name and folder. For a first-time setup, suggest:
- **Name:** Main Assistant
- **Folder:** main

The command creates `agents/{folder}/CLAUDE.md` and adds the agent to `hydra.yaml`.

## 5. Test with Interactive CLI

Start an interactive Claude Code session inside the agent's container:

```bash
hydra exec main
```

This drops you into a live Claude Code session with the agent's isolated workspace mounted. Type a message to verify everything works, then exit with `/exit` or Ctrl+C.

**If this works, basic setup is complete.** The sections below are optional enhancements.

---

## Optional: Telegram Integration

Ask the user:
> Do you want to connect agents to Telegram? This lets you message agents from your phone.

If **no**, skip to the next optional section.

### 6a. Create a Telegram Bot

Ask the user:
> Do you already have a Telegram bot token, or do you need to create one?

**Create new:**

Tell the user:
> 1. Open Telegram and message @BotFather
> 2. Send `/newbot` and follow the prompts
> 3. Copy the bot token (looks like `123456:ABC-DEF...`)
> 4. Paste it here

**Use existing:** Ask them to paste the token.

Once you have the token, add it to `.env`:

```bash
echo "TELEGRAM_BOT_TOKEN=<token>" >> .env
```

### 6b. Update hydra.yaml

Ask the user:
> What name should your bot use in Telegram?
>
> Default: `Hydra`

Add the bot and update the agent config in `hydra.yaml`:

```yaml
bots:
  main:
    name: <ASSISTANT_NAME>
    token: env:TELEGRAM_BOT_TOKEN
    platform: telegram

agents:
  - name: Main Assistant
    folder: main
    trigger: "@<ASSISTANT_NAME>"
    bot: main
    chat_id: ""  # Will be populated when you message the bot
```

Replace `<ASSISTANT_NAME>` with their choice.

Tell the user:
> After starting the orchestrator (`hydra up`), message your bot in Telegram. The chat ID will be captured automatically.

---

## Optional: Background Orchestrator

The orchestrator (`hydra up`) runs in the background and enables:
- Telegram bot listener (receives messages when you're not in a CLI session)
- Task scheduler (cron, interval, one-time tasks)
- IPC message routing
- REST API + WebSocket for the web console

Ask the user:
> Do you want to set up the background orchestrator?

If **no**, skip ahead. They can always run `hydra up` later.

### 7a. Start the Orchestrator

```bash
npm run build
hydra up
```

Verify:
```bash
hydra status
```

### 7b. System Service (Auto-Start on Boot)

Ask the user:
> Do you want Hydra to start automatically on boot?

If **no**, they can start manually with `hydra up`.

Detect the platform:

```bash
echo "Platform: $(uname -s)"
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

## Optional: Mount Allowlist

Ask the user:
> Do you want agents to access any directories **outside** the Hydra project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** Without this, agents can only access their own agent folders.

If **no**, create an empty allowlist:

```bash
mkdir -p ~/.config/hydra
cat > ~/.config/hydra/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

If **yes**, ask:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?

Create the allowlist:

```bash
mkdir -p ~/.config/hydra
cat > ~/.config/hydra/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

---

## Troubleshooting

**Container agent fails:**
- Ensure Docker is running: `docker info`
- Check container logs: `cat agents/main/logs/container-*.log | tail -50`

**`hydra exec` hangs or errors:**
- Verify the container image exists: `docker images | grep hydra-agent`
- Rebuild if needed: `./container/build.sh`

**Orchestrator not starting:**
- Linux: `journalctl --user -u hydra -f`
- macOS: Check `logs/hydra.error.log`
- Manual start: `hydra up --foreground` to see errors directly

**No response to Telegram messages:**
- Verify trigger pattern matches (e.g., `@BotName` at start of message)
- Check `hydra status` to confirm orchestrator is running
- Check logs: `hydra logs`
