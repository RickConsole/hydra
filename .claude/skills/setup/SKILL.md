---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp/Gmail, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

**IMPORTANT**: Run all commands automatically. Only pause for user action when physical interaction is required (scanning QR codes). Give clear instructions for exactly what the user needs to do.

## 1. Check Prerequisites

Run these checks. Install any that are missing:

```bash
python3 --version  # Need 3.10+
node --version     # Need 18+
uv --version
```

If missing, install automatically:
- **uv**: `curl -LsSf https://astral.sh/uv/install.sh | sh`
- **node**: `brew install node`
- **python**: `brew install python@3.10`

## 2. Install Dependencies

Run all of these automatically:

```bash
# Python dependencies
uv venv && source .venv/bin/activate && uv pip install -r requirements.txt
```

```bash
# WhatsApp bridge dependencies
cd bridge && npm install
```

```bash
# Create logs directory
mkdir -p logs
```

## 3. WhatsApp Authentication

**USER ACTION REQUIRED**

Run the bridge in background and monitor for connection:

```bash
cd bridge && node bridge.js > /tmp/bridge_output.log 2>&1 &
BRIDGE_PID=$!
```

Tell the user:
> A QR code will appear below. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Then poll for either QR code or successful connection (check every 2 seconds for up to 3 minutes):

```bash
cat /tmp/bridge_output.log  # Look for QR code or "Connected to WhatsApp!"
```

When you see "Connected to WhatsApp!" in the output, stop the bridge:
```bash
kill $BRIDGE_PID
```

Session persists until logged out from WhatsApp.

## 4. Gmail Authentication (Optional)

**Skip this step** unless user specifically needs Gmail integration. It requires Google Cloud Platform OAuth credentials setup.

If needed, user must first:
1. Create a GCP project
2. Enable Gmail API
3. Create OAuth 2.0 credentials
4. Download credentials to `~/.gmail-mcp/gcp-oauth.keys.json`

Then run:
```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp
```

## 5. Register Main Channel

Ask the user:
> Do you want to use a **personal chat** (message yourself) or a **WhatsApp group** as your main channel?

For personal chat:
> Send a test message to yourself in WhatsApp. Tell me when done.

For group:
> Send a message in the WhatsApp group you want to use. Tell me when done.

After user confirms, find the JID:

```bash
# For personal chat
sqlite3 bridge/store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid NOT LIKE '%@g.us' ORDER BY rowid DESC LIMIT 5"

# For group
sqlite3 bridge/store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@g.us' ORDER BY rowid DESC LIMIT 5"
```

Read the assistant name from `src/config.py` (look for `ASSISTANT_NAME = "..."`).

Then update `data/registered_groups.json`:
```json
{
  "THE_JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@AssistantName",
    "added_at": "CURRENT_TIMESTAMP_ISO"
  }
}
```

## 6. Configure launchd

First, detect the actual paths:

```bash
which node    # Get actual node path (may be nvm, homebrew, etc.)
```

Create plist files directly in `~/Library/LaunchAgents/` with:

**com.nanoclaw.bridge.plist:**
- ProgramArguments: `[actual_node_path, /Users/.../nanoclaw/bridge/bridge.js]`
- WorkingDirectory: `/Users/.../nanoclaw/bridge`
- StandardOutPath/StandardErrorPath: `/Users/.../nanoclaw/logs/bridge.log` and `bridge.error.log`

**com.nanoclaw.router.plist:**
- ProgramArguments: `[/Users/.../nanoclaw/.venv/bin/python, -u, /Users/.../nanoclaw/src/router.py]`
  - The `-u` flag is required for unbuffered output (so logs appear immediately)
- WorkingDirectory: `/Users/.../nanoclaw`
- EnvironmentVariables:
  - `PATH`: `/Users/USERNAME/.local/bin:/usr/local/bin:/usr/bin:/bin` (must include path to `claude` CLI)
  - `HOME`: `/Users/USERNAME` (required for Claude CLI to find its config)
- StandardOutPath/StandardErrorPath: `/Users/.../nanoclaw/logs/router.log` and `router.error.log`

**NOTE**: Do NOT set ANTHROPIC_API_KEY - the Claude CLI handles its own authentication.

Then load the services:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.bridge.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.router.plist
```

Verify they're running:
```bash
launchctl list | grep nanoclaw
```

## 7. Test

Wait a few seconds for services to start, then tell the user:
> Send `@AssistantName hello` in your registered chat/group.

Check `logs/router.log` for activity:
```bash
tail -f logs/router.log
```

If there are issues, also check:
- `logs/router.error.log`
- `logs/bridge.log`
- `logs/bridge.error.log`

## Troubleshooting

**"Command failed with exit code 1"** - Usually means the Claude CLI isn't in PATH. Verify PATH in the router plist includes the directory containing `claude` (typically `~/.local/bin`).

**Messages received but no WhatsApp response** - Check that the bridge HTTP server is running:
```bash
curl -s http://127.0.0.1:3141/send -X POST -H "Content-Type: application/json" -d '{"jid":"test","message":"test"}'
```
Should return an error about invalid JID (not connection refused).

**Router not processing messages** - Check the trigger pattern matches. Messages must start with the trigger (e.g., `@Andy hello`).
