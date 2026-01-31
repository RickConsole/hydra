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

## 3. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> Messages starting with `@TriggerWord` will be sent to Claude.

Store their choice - you'll use it when creating the registered_groups.json and when telling them how to test.

## 4. Register Main Channel

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

Create/update `data/registered_groups.json` using the JID from above and the assistant name from step 3:
```json
{
  "JID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 5. Gmail Authentication (Optional)

Ask the user:
> Do you want to enable Gmail integration for reading/sending emails?
>
> **Note:** This requires setting up Google Cloud Platform OAuth credentials, which involves:
> 1. Creating a GCP project
> 2. Enabling the Gmail API
> 3. Creating OAuth 2.0 credentials
> 4. Downloading a credentials file
>
> This takes about 5-10 minutes. Skip if you don't need email integration.

If yes, guide them through the prerequisites:
1. Go to https://console.cloud.google.com
2. Create a new project (or use an existing one)
3. Enable the Gmail API (APIs & Services → Enable APIs → search "Gmail API")
4. Create OAuth 2.0 credentials (APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app)
5. Download the JSON file and save to `~/.gmail-mcp/gcp-oauth.keys.json`

Then run:
```bash
npx -y @gongrzhe/server-gmail-autoauth-mcp
```

This will open a browser for OAuth consent. After authorization, credentials are cached.

## 6. Configure launchd Service

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

## 7. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in WhatsApp.

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
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
