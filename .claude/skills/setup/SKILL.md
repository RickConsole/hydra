---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp/Gmail, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (scanning QR codes).

## 1. Install Dependencies

```bash
npm install
```

## 2. WhatsApp Authentication

**USER ACTION REQUIRED**

Run the authentication script:

```bash
npm run auth
```

Tell the user:
> A QR code will appear. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Wait for the script to output "Successfully authenticated" then continue.

If it says "Already authenticated", skip to the next step.

## 3. Register Main Channel

Ask the user:
> Do you want to use your **personal chat** (message yourself) or a **WhatsApp group** as your main control channel?

For personal chat:
> Send any message to yourself in WhatsApp (the "Message Yourself" chat). Tell me when done.

For group:
> Send any message in the WhatsApp group you want to use as your main channel. Tell me when done.

After user confirms, start the app briefly to capture the message:

```bash
timeout 10 npm run dev || true
```

Then find the JID from the database:

```bash
# For personal chat (ends with @s.whatsapp.net)
sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@s.whatsapp.net' ORDER BY timestamp DESC LIMIT 5"

# For group (ends with @g.us)
sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@g.us' ORDER BY timestamp DESC LIMIT 5"
```

Get the assistant name from environment or default:
```bash
echo ${ASSISTANT_NAME:-Andy}
```

Create/update `data/registered_groups.json`:
```json
{
  "THE_JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@Andy",
    "added_at": "2026-01-31T12:00:00Z"
  }
}
```

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 4. Gmail Authentication (Optional)

Ask the user:
> Do you want to enable Gmail integration for reading/sending emails?

If yes, they need Google Cloud Platform OAuth credentials first:
1. Create a GCP project at https://console.cloud.google.com
2. Enable the Gmail API
3. Create OAuth 2.0 credentials (Desktop app)
4. Download and save to `~/.gmail-mcp/gcp-oauth.keys.json`

Then run:
```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp
```

This will open a browser for OAuth consent. After authorization, credentials are cached.

## 5. Configure launchd Service

Get the actual paths:

```bash
which node
pwd
```

Create the plist file at `~/Library/LaunchAgents/com.nanoclaw.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>NODE_PATH_HERE</string>
        <string>PROJECT_PATH_HERE/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>PROJECT_PATH_HERE</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:HOME_PATH_HERE/.local/bin</string>
        <key>HOME</key>
        <string>HOME_PATH_HERE</string>
    </dict>
    <key>StandardOutPath</key>
    <string>PROJECT_PATH_HERE/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>PROJECT_PATH_HERE/logs/nanoclaw.error.log</string>
</dict>
</plist>
```

Replace the placeholders with actual paths from the commands above.

Build and start the service:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:
```bash
launchctl list | grep nanoclaw
```

## 6. Test

Tell the user:
> Send `@Andy hello` in your registered chat.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in WhatsApp.

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**No response to messages**:
- Verify the trigger pattern matches (`@Andy` at start of message)
- Check that the chat JID is in `data/registered_groups.json`
- Check `logs/nanoclaw.log` for errors

**WhatsApp disconnected**:
- The service will show a macOS notification
- Run `npm run auth` to re-authenticate
- Restart the service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
