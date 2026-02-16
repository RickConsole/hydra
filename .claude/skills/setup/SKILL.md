---
name: setup
description: Run initial Hydra setup. Use when user wants to install dependencies, configure channels (Web Console, Telegram), or start the background services. Triggers on "setup", "install", "configure hydra", or first-time setup requests.
---

# Hydra Setup

Run all commands automatically. Only pause when user action is required.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Container Runtime

First, detect the platform and check what's available:

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
which docker && docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

### If NOT on macOS (Linux, etc.)

Apple Container is macOS-only. Use Docker instead.

Tell the user:
> You're on Linux, so we'll use Docker for container isolation. Docker should already be installed and running.

### If on macOS

**If Docker is installed and running:** Continue to Section 3.

**If Apple Container is already installed:** Continue to Section 3.

**If neither is available:** Ask the user:
> Hydra needs a container runtime for isolated agent execution. You have two options:
>
> 1. **Docker** (recommended) - Cross-platform, widely used, works on macOS and Linux
> 2. **Apple Container** - macOS-native, lightweight, designed for Apple silicon
>
> Which would you prefer?

#### Option A: Docker (Recommended)

Tell the user:
> Please install Docker Desktop from https://docker.com/products/docker-desktop/
>
> Let me know when you've installed and started Docker.

Wait for user confirmation, then verify:

```bash
docker info >/dev/null 2>&1 && echo "Docker is running" || echo "Docker is not running"
```

#### Option B: Apple Container

Tell the user:
> Apple Container is required for running agents in isolated environments.
>
> 1. Download the latest `.pkg` from https://github.com/apple/container/releases
> 2. Double-click to install
> 3. Run `container system start` to start the service
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
container system start
container --version
```

## 3. Configure Claude Authentication

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

## 4. Build Container Image

Build the Hydra agent container:

```bash
./container/build.sh
```

This creates the `hydra-agent:latest` image (or `nanoclaw-agent:latest` if using older naming) with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify the build succeeded:

```bash
if which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '{}' | docker run -i --rm --entrypoint /bin/echo hydra-agent:latest "Container OK" 2>/dev/null || \
  echo '{}' | docker run -i --rm --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
else
  echo '{}' | container run -i --entrypoint /bin/echo hydra-agent:latest "Container OK" 2>/dev/null || \
  echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
fi
```

## 5. Choose Communication Channels

**Use the AskUserQuestion tool** to present this:

> **How do you want to communicate with Hydra?**
>
> Options:
> 1. **Web Console only** (recommended for testing) - Use the built-in web UI at localhost:3000
> 2. **Telegram only** - Use a Telegram bot
> 3. **Both** - Web Console + Telegram

### Option 1: Web Console Only

This is the simplest setup. Create a minimal `hydra.yaml`:

```bash
cat > hydra.yaml << 'EOF'
version: "1"
project: hydra

bots: {}

agents:
  - name: Main Assistant
    folder: main
    trigger: "@Assistant"
EOF
```

Skip to Section 8 (Configure Mount Allowlist).

### Option 2: Telegram Only

Continue to Section 6.

### Option 3: Both

Continue to Section 6, then the web console will also be available.

## 6. Configure Telegram Bot

Ask the user:
> Do you already have a Telegram bot token, or do you need to create one?

### Create New Bot

Tell the user:
> 1. Open Telegram and message @BotFather
> 2. Send `/newbot` and follow the prompts
> 3. Copy the bot token (looks like `123456:ABC-DEF...`)
> 4. Paste it here

### Use Existing Bot

Ask them to paste the token.

Once you have the token, add it to `.env`:

```bash
# Append to .env (don't overwrite existing content)
echo "TELEGRAM_BOT_TOKEN=<token>" >> .env
```

## 7. Create Hydra Configuration

Ask the user:
> What name should your assistant use? (This is what users will see in Telegram)
>
> Default: `Hydra`

Create `hydra.yaml`:

```bash
cat > hydra.yaml << 'EOF'
version: "1"
project: hydra

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
EOF
```

Replace `<ASSISTANT_NAME>` with their choice.

Tell the user:
> Your Telegram bot is configured. After starting the service:
> 1. Open Telegram and message your bot
> 2. Send any message starting with `@<ASSISTANT_NAME>`
> 3. The chat ID will be captured and you can update hydra.yaml with it

## 8. Configure Mount Allowlist (Optional)

Ask the user:
> Do you want agents to access any directories **outside** the Hydra project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

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

Skip to Section 9.

If **yes**, ask follow-up questions:

### 8a. Collect Directory Paths

Ask the user:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory they provide, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?

### 8b. Create the Allowlist

Create the allowlist file based on their answers:

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

## 9. Configure System Service

Detect the platform and create the appropriate service:

```bash
echo "Platform: $(uname -s)"
```

### macOS (launchd)

Generate the plist file:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

mkdir -p ~/Library/LaunchAgents
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

echo "Created launchd plist at ~/Library/LaunchAgents/com.hydra.plist"
```

Build and start:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.hydra.plist
```

Verify:
```bash
launchctl list | grep hydra
```

### Linux (systemd)

Generate the systemd unit:

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

echo "Created systemd unit at ~/.config/systemd/user/hydra.service"
```

Build and start:

```bash
npm run build
mkdir -p logs
systemctl --user daemon-reload
systemctl --user enable hydra
systemctl --user start hydra
```

Verify:
```bash
systemctl --user status hydra
```

## 10. Start Hydra Console (Web UI)

If using the web console:

```bash
cd hydra-console
npm install
npm run build
npm start &
```

Or for development:
```bash
cd hydra-console
npm run dev &
```

The console will be available at http://localhost:3000

## 11. Test

**For Web Console:**
> Open http://localhost:3000 in your browser. You should see the Hydra Console.
> Click on the "main" agent and send a test message.

**For Telegram:**
> Send a message to your bot starting with `@<ASSISTANT_NAME> hello`

Check the logs:
```bash
tail -f logs/hydra.log
```

## Remote Access (SSH Port Forwarding)

If you want to access Hydra from a remote machine:

```bash
# Forward both the API and Console ports
ssh -L 3000:localhost:3000 -L 3340:localhost:3340 user@server
```

Then open http://localhost:3000 on your local machine.

## Troubleshooting

**Service not starting**:
- macOS: Check `logs/hydra.error.log`
- Linux: `journalctl --user -u hydra -f`

**Container agent fails with "Claude Code process exited with code 1"**:
- Ensure Docker is running: `docker info`
- Or Apple Container: `container system start`
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**Web Console can't connect to API**:
- Verify the orchestrator is running on port 3340
- Check `NEXT_PUBLIC_ORCHESTRATOR_URL` if using non-default ports

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start)
- Check `logs/hydra.log` for errors

**Unload service (macOS)**:
```bash
launchctl unload ~/Library/LaunchAgents/com.hydra.plist
```

**Stop service (Linux)**:
```bash
systemctl --user stop hydra
```
