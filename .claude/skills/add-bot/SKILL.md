---
name: add-bot
description: Add a new Telegram bot to NanoClaw with its own personality, group folder, and isolated conversations. Guides through BotFather setup, bots.json configuration, group registration, and CLAUDE.md creation.
---

# Add a New Telegram Bot

This skill walks through adding a new bot to the multi-bot NanoClaw system. Each bot gets its own Telegram token, personality (via `CLAUDE.md`), trigger name, and isolated DM/group conversations.

## Prerequisites

Before starting, verify multi-bot support is in place:

```bash
cat data/bots.json
```

This should show at least one existing bot entry. If the file doesn't exist, the system needs the multi-bot migration first (see the codebase's multi-bot implementation).

## Step 1: Create the Telegram Bot

Ask the user:

> I'll help you add a new bot. First, you need to create it via Telegram's BotFather.
>
> 1. Open Telegram and message `@BotFather`
> 2. Send `/newbot`
> 3. **Bot name:** Choose a display name (e.g., "Sara", "Kai", "Mira")
> 4. **Bot username:** Must end with "bot" and be unique (e.g., `sara_assistant_bot`)
> 5. Copy the **token** BotFather gives you
>
> What is the bot token?

Wait for the user to provide the token.

### Validate the Token

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe" | jq '.result'
```

This should return the bot's username and name. If it returns an error, the token is invalid.

## Step 2: Choose a Bot Key and Name

Ask the user:

> What should I call this bot?
>
> - **Display name**: The name shown in conversations and used as the trigger (e.g., "Sara")
> - **Bot key**: A short lowercase identifier used internally (e.g., "sara")
>
> The trigger pattern will be `@Name` (e.g., `@Sara` in group chats).
>
> What name do you want?

The bot key should be:
- Lowercase
- No spaces or special characters
- Short (used in JID format: `telegram:botkey:chatid`)

If the user just gives a name like "Sara", derive the key as `sara`.

## Step 3: Update `data/bots.json`

Read the current bots.json:

```bash
cat data/bots.json
```

Add the new bot entry. The format is:

```json
{
  "existing_key": { "token": "...", "name": "ExistingBot" },
  "new_key": { "token": "NEW_TOKEN_HERE", "name": "NewBotName" }
}
```

Write the updated file. **Do not modify existing entries.**

## Step 4: Create the Group Folder

Ask the user:

> What folder name should this bot's DM conversations use?
>
> This will be under `groups/` and holds the bot's personality (`CLAUDE.md`), logs, and memory files.
>
> Suggestions:
> - Same as bot key (e.g., `sara`)
> - Descriptive name (e.g., `sara-personal`)
>
> What folder name?

Create the folder structure:

```bash
mkdir -p groups/<folder>/logs
```

## Step 5: Copy Claude Credentials

Each bot gets an isolated `.claude/` directory inside `data/sessions/<folder>/.claude/`. New bots need a copy of the Claude authentication credentials, otherwise the container agent will fail with exit code 1.

Copy the credentials from an existing working bot (e.g., the main bot):

```bash
mkdir -p data/sessions/<folder>/.claude
cp data/sessions/main/.claude/.credentials.json data/sessions/<folder>/.claude/.credentials.json
```

Verify it was copied:

```bash
ls -la data/sessions/<folder>/.claude/.credentials.json
```

**Why this is needed:** The container mounts `data/sessions/<folder>/.claude/` as `/home/node/.claude/` inside the container. Claude Code reads `.credentials.json` from there to authenticate API calls. Without it, the agent process exits immediately with code 1.

## Step 6: Write the Bot's Personality (`CLAUDE.md`)

This is the most important step. The `CLAUDE.md` file defines who this bot is.

Ask the user:

> How should this bot behave? Tell me about its personality:
>
> - **Role**: What does it do? (personal assistant, coding helper, writing coach, etc.)
> - **Tone**: How should it communicate? (casual, professional, playful, etc.)
> - **Special abilities**: Any specific focus areas?
> - **Anything else** about how it should act?

Create `groups/<folder>/CLAUDE.md` based on their description. Use this template as a starting point:

```markdown
# <BotName>

You are <BotName>, <one-line description>.

## Personality

<Describe tone, style, and character traits>

## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- Read and write files in your workspace
- Run bash commands in your sandbox
- Schedule tasks to run later or on a recurring basis

## Communication

You are accessed via **Telegram** using the bot **@<bot_username>** (display name: <BotName>).

Messages support standard Telegram formatting:
- **Bold** (double asterisks)
- *Italic* (single asterisks)
- `Code` (backticks)
- ```Code blocks``` (triple backticks)

Keep messages clean and readable for Telegram chat.

## Memory

You have persistent memory via mem0 (`mcp__mem0__*` tools). Use it actively — it's how you maintain context across conversations.

### Before Responding

Search memory at the start of every conversation to load relevant context:
- `memory_search` with the topic at hand before answering questions or making decisions
- This is critical — without it you're starting from scratch every time

### What to Remember

Store anything that would be painful to re-explain or re-discover. Tailor the categories to the bot's role and domain. Each memory should be specific and self-contained — it should make sense on its own without needing other memories for context.

### When to Forget

Use `memory_forget` to remove memories that are outdated or superseded. Stale memories are worse than no memories.
```

**Key differences from the main bot:**
- Do NOT include the "Admin Context" section (only main gets admin privileges)
- Do NOT include the "Managing Groups" section
- DO customize the personality section based on user input
- DO include any special instructions or constraints

## Step 7: Get the Chat ID

Tell the user:

> Now I need your Telegram chat ID for this bot. Here's how:
>
> 1. Open Telegram and find your new bot by username
> 2. Send it any message (e.g., "hello")
> 3. Run this command:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[-1].message.chat.id'
```

> That number is your chat ID. What is it?

## Step 8: Register the Chat

The JID format is `telegram:<botkey>:<chatid>`.

Read `data/registered_groups.json` and add the new entry:

```json
{
  "telegram:<botkey>:<chatid>": {
    "name": "<display_name>",
    "folder": "<folder>",
    "trigger": "@<BotName>",
    "added_at": "<current ISO timestamp>"
  }
}
```

Write the updated file. **Do not modify existing entries.**

**For DM conversations:** The registered group IS the DM — each bot's DM with a user is a separate registered entry.

**For Telegram group chats:** The same process applies but with a negative chat ID. The bot will only respond when mentioned with `@BotName` in group chats.

## Step 9: Restart NanoClaw

Build and restart:

```bash
npm run build
```

```bash
systemctl --user restart nanoclaw
```

Verify it's running:

```bash
systemctl --user status nanoclaw
```

Check that both bots started:

```bash
journalctl --user -u nanoclaw -n 30 | grep -i "bot.*launch\|registry"
```

You should see log lines showing each bot key being launched.

## Step 10: Test

Tell the user:

> Send a message to your new bot in Telegram. It should:
> 1. Show a typing indicator
> 2. Respond with its configured personality
> 3. Not affect your other bot's conversations
>
> Try it now!

If it doesn't respond, check:

```bash
journalctl --user -u nanoclaw -n 50 | grep -i "unregistered\|error"
```

Common issues:
- **"unregistered Telegram chat"** — The chat ID or bot key in registered_groups.json doesn't match. Verify the JID format is `telegram:<botkey>:<chatid>`.
- **Bot doesn't start** — Check bots.json for JSON syntax errors.
- **Wrong personality** — Check that the `folder` in registered_groups.json points to the correct group folder with the right CLAUDE.md.

## Step 11: Optional — Add Skills

If the new bot needs custom tools or skills (like the X integration), they're configured per-group via:

1. **Container mounts**: Add `containerConfig.additionalMounts` to the registered group entry for directory access
2. **MCP tools**: Skills defined in `.claude/skills/` are available to all bots. Bot-specific behavior comes from the CLAUDE.md personality, not from skill restrictions.
3. **Environment variables**: If the bot needs specific API keys, add them to `.env` and sync:
   ```bash
   cp .env data/env/env
   ```

## Summary of Files Modified

| File | Change |
|------|--------|
| `data/bots.json` | Added new bot entry (token + name) |
| `data/registered_groups.json` | Added chat registration with new JID format |
| `groups/<folder>/CLAUDE.md` | Created bot personality |
| `groups/<folder>/logs/` | Created log directory |

## Adding More Chats to This Bot

To register additional chats (more users DMing this bot, or group chats):

1. Get the chat ID (send a message, use getUpdates API)
2. Add to `data/registered_groups.json` with the same bot key: `telegram:<botkey>:<new_chatid>`
3. Choose a folder (can reuse same folder for shared context, or create new one for isolation)
4. Restart: `npm run build && systemctl --user restart nanoclaw`
