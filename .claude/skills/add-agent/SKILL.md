---
name: add-agent
description: Create a new Hydra agent with full configuration. Use when user wants to add an agent, new agent, create agent, or set up another agent. Walks through persona, mounts, Telegram, model, and secrets.
---

# Add Agent

Interactive wizard for creating a fully configured Hydra agent. Handles persona customization, mount configuration, Telegram integration, model selection, and environment variables.

Run all commands automatically. Only pause when user action is required (choosing options, pasting tokens).

**UX Note:** Use `AskUserQuestion` for all choices instead of plain text prompts.

---

## 0. Prerequisites

Check that the project is ready for agent creation:

```bash
[ -f hydra.yaml ] && echo "Config exists" || echo "NO_CONFIG"
```

If `hydra.yaml` does not exist, tell the user:
> You need to run `/setup` first to create the base configuration.

Stop here if no config.

```bash
docker images | grep hydra-agent | head -5
```

If no image found, build it:
```bash
./container/build.sh
```

Read the current state:
```bash
cat hydra.yaml
```

Also check for the mount allowlist:
```bash
[ -f ~/.config/hydra/mount-allowlist.json ] && cat ~/.config/hydra/mount-allowlist.json || echo "NO_ALLOWLIST"
```

Note existing agents, bots, and security config for later steps.

---

## 1. Agent Identity

Ask the user:

> **What should this agent be called?**
>
> **Name:** Display name (e.g., "Merlin", "Dev Helper", "Research Bot")
> **Folder:** Short lowercase identifier (e.g., "merlin", "dev", "research")

Suggest folder as `name.toLowerCase().replace(/\s+/g, '-')`.

Validate:
- Folder must match `^[a-z0-9_-]+$`
- Folder must not already exist in `agents/` or in `hydra.yaml` agents list

Create the agent:
```bash
hydra agent create --name "<NAME>" --folder <FOLDER>
```

This creates `agents/<FOLDER>/CLAUDE.md` with a template and appends a basic entry to `hydra.yaml`.

---

## 2. Persona & Model

### Persona

Ask the user:

> How should this agent behave? Describe its role and personality.
>
> Examples:
> - "You are a senior full-stack developer focused on TypeScript and React"
> - "You are a research assistant that summarizes papers and finds citations"
> - "You are a DevOps engineer that helps with infrastructure and deployments"
>
> Or **skip** to keep the default generic persona.

If the user provides a persona description:

1. Read `agents/<FOLDER>/CLAUDE.md`
2. Replace the line `You are <NAME>. Describe your persona and capabilities here.` with the user's description
3. Keep the `## Filesystem Layout`, `## Memory`, and all other sections intact

### Model

Ask the user:

> Which Claude model should this agent use?
>
> 1. **Sonnet** (Recommended) — fast, capable, cost-effective
> 2. **Opus** — most capable, slower, higher cost
> 3. **Skip** — use system default

If a model is selected, read `hydra.yaml`, find the agent entry just created, and add `model: sonnet` or `model: opus` to it. Use the Edit tool to modify `hydra.yaml`.

---

## 3. Mounts

Ask the user:

> Does this agent need access to directories outside its own agent folder?
>
> Examples: source code repos (`~/src`), project folders, documents.
> Without mounts, the agent can only access `agents/<FOLDER>/`.

If **no**, skip to Section 4.

If **yes**:

### Existing Roots

Check what's already configured. Read `hydra.yaml` `security.mounts.allowed_roots` and `~/.config/hydra/mount-allowlist.json`.

If there are existing allowed roots, present them:

> These directories are already allowed for mounting:
> - `~/src` (read-write) — Source code repositories
> - `~/projects` (read-write) — Project files
>
> Which should this agent access? Or add a new directory.

### New Roots

If the user wants a directory not in the allowed roots:

Ask:
> What host directory? (e.g., `~/Documents`, `~/projects/myapp`)

Ask:
> Should it be **read-write** or **read-only**?

Then update **both** files:

1. **`hydra.yaml`** — add to `security.mounts.allowed_roots` if not already present:
   ```yaml
   security:
     mounts:
       allowed_roots:
         - path: ~/new-dir
           allow_read_write: true
           description: User-provided description
   ```

2. **`~/.config/hydra/mount-allowlist.json`** — add to `allowedRoots` array (create file if needed):
   ```json
   {
     "path": "~/new-dir",
     "allowReadWrite": true,
     "description": "User-provided description"
   }
   ```
   Note: allowlist uses **camelCase**, hydra.yaml uses **snake_case**.

   If the file doesn't exist, create it with default blocked patterns:
   ```json
   {
     "allowedRoots": [...],
     "blockedPatterns": [
       ".ssh", ".gnupg", ".aws", "credentials", ".env",
       ".netrc", ".npmrc", "id_rsa", "id_ed25519", "private_key", ".secret"
     ],
     "nonMainReadOnly": true
   }
   ```

### Add Mounts to Agent

For each directory the user selected, add a `container.mounts` entry to the agent in `hydra.yaml`:

```yaml
    container:
      mounts:
        - host_path: ~/src
          container_path: src
          readonly: false
```

The `container_path` should be a short name derived from the last segment of the host path.

### Update Agent's CLAUDE.md

Read `agents/<FOLDER>/CLAUDE.md` and update the Filesystem Layout table to include the actual mount paths:

```markdown
| `/workspace/extra/<container_path>/` | Mounted from `<host_path>` on the host — <description>. |
```

Add a row for each mount, keeping the existing rows intact.

---

## 4. Integration

Ask the user:

> How will you interact with this agent?
>
> 1. **CLI only** (default) — use `hydra exec <FOLDER>` to chat
> 2. **Telegram** — connect to a Telegram bot for mobile access

If **CLI only**, skip to Section 5.

If **Telegram**:

### Existing Bots

Check `hydra.yaml` `bots:` section. If bots exist, present them:

> You have these Telegram bots configured:
> - `anton` — Anton
> - `merlin` — Merlin
>
> Use an existing bot, or create a new one?

### Existing Bot

If user picks an existing bot, get the bot's name for the trigger.

### New Bot

If creating a new bot:

1. Tell the user:
   > 1. Open Telegram and message @BotFather
   > 2. Send `/newbot` and follow the prompts
   > 3. Copy the bot token (looks like `123456:ABC-DEF...`)
   > 4. Paste the token here

2. Ask for the bot's name (used as trigger word)

3. Choose an env var name (e.g., `NEW_BOT_TOKEN`) and add to `.env`:
   ```bash
   echo "NEW_BOT_TOKEN=<token>" >> .env
   ```

4. Add bot entry to `hydra.yaml` `bots:` section:
   ```yaml
   bots:
     <bot_key>:
       name: <BotName>
       token: env:NEW_BOT_TOKEN
       platform: telegram
   ```

### Update Agent Entry

Add trigger, bot, and chat_id to the agent entry in `hydra.yaml`:

```yaml
    trigger: "@<BotName>"
    bot: <bot_key>
    chat_id: ""        # Auto-populated when user first messages the bot
```

---

## 5. Environment Variables / Secrets

Ask the user:

> Does this agent need any additional environment variables?
>
> Examples: `GITHUB_TOKEN`, `OPENAI_API_KEY`, custom API keys.
>
> Default variables (ANTHROPIC_API_KEY, memory keys) are automatically available.
> Choose **skip** if no additional variables are needed.

If the user provides variables:

For each variable:
1. Ask for the variable name and value
2. Check if it already exists in `.env`
3. If not, append to `.env`:
   ```bash
   echo "<VAR_NAME>=<value>" >> .env
   ```
4. Document in `agents/<FOLDER>/CLAUDE.md` — add a note about available environment variables (without exposing actual values)

---

## 6. Validate & Test

Run validation:
```bash
hydra config validate
```

If validation fails, read the error carefully and fix the config. Common issues:
- Bot referenced in agent doesn't exist in `bots:` section
- Duplicate agent folders
- Invalid folder names
- Missing required fields

If validation passes, ask the user:

> Want to test the agent interactively?

If yes:
```bash
hydra exec <FOLDER>
```

Tell the user:
> This drops you into a live Claude Code session inside the agent's container.
> Type a message to test. Exit with `/exit` or Ctrl+C.

---

## 7. Summary

Print a summary of everything created:

> **Agent created successfully!**
>
> | Setting | Value |
> |---------|-------|
> | Name | <NAME> |
> | Folder | `agents/<FOLDER>/` |
> | Persona | <custom/default> |
> | Model | <sonnet/opus/default> |
> | Mounts | <list or "none"> |
> | Integration | <CLI only / Telegram via @BotName> |
> | Extra env vars | <list or "none"> |
>
> **Files modified:**
> - `agents/<FOLDER>/CLAUDE.md` — agent persona
> - `hydra.yaml` — agent entry added
> - `.env` — (if new tokens/keys added)
> - `~/.config/hydra/mount-allowlist.json` — (if new roots added)
>
> **Next steps:**
> - Edit `agents/<FOLDER>/CLAUDE.md` to further refine the persona
> - Run `hydra exec <FOLDER>` to chat with the agent
> - Run `/add-agent` again to create another agent
