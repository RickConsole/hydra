---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS)                          Container (Linux VM)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns Apple Container               │ runs Claude Agent SDK
    │ with volume mounts                   │ with MCP servers
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc ──────────────────> /workspace/ipc
    └── (main only) project root ──> /workspace/project
```

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `logs/nanoclaw.log` | Host-side WhatsApp, routing, container spawning |
| **Main app errors** | `logs/nanoclaw.error.log` | Host-side errors |
| **Container run logs** | `groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |
| **Claude sessions** | `~/.claude/projects/` | Claude Code session history |

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output:

```bash
# For development
LOG_LEVEL=debug npm run dev

# For launchd service, add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. "Claude Code process exited with code 1"

**Check the container log file** in `groups/{folder}/logs/container-*.log`

Common causes:

#### Missing API Key
```
Invalid API key · Please run /login
```
**Fix:** Ensure `.env` file exists in project root with valid `ANTHROPIC_API_KEY`:
```bash
cat .env  # Should show: ANTHROPIC_API_KEY=sk-ant-...
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

**Apple Container Bug:** Environment variables passed via `-e` are lost when using `-i` (interactive/piped stdin).

**Workaround:** The system mounts `.env` as a file and sources it inside the container.

To verify env vars are reaching the container:
```bash
echo '{}' | container run -i \
  --mount type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly \
  --entrypoint /bin/bash nanoclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "API key length: ${#ANTHROPIC_API_KEY}"'
```

### 3. Mount Issues

**Apple Container quirks:**
- Only mounts directories, not individual files
- `-v` syntax does NOT support `:ro` suffix - use `--mount` for readonly:
  ```bash
  # Readonly: use --mount
  --mount "type=bind,source=/path,target=/container/path,readonly"

  # Read-write: use -v
  -v /path:/container/path
  ```

To check what's mounted inside a container:
```bash
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env     # Environment file (ANTHROPIC_API_KEY)
├── group/          # Current group folder (cwd)
├── project/        # Project root (main channel only)
├── global/         # Global CLAUDE.md (non-main only)
├── ipc/            # Inter-process communication
│   ├── messages/   # Outgoing WhatsApp messages
│   └── tasks/      # Scheduled task commands
└── extra/          # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. MCP Server Failures

If an MCP server fails to start, the agent may exit. Test MCP servers individually:

```bash
# Test Gmail MCP
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  npx -y @gongrzhe/server-gmail-autoauth-mcp --help
'
```

## Manual Container Testing

### Test the full agent flow:
```bash
# Set up env file
mkdir -p data/env groups/test
cp .env data/env/env

# Run test query
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}' | \
  container run -i \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc:/workspace/ipc \
  nanoclaw-agent:latest
```

### Test Claude Code directly:
```bash
container run --rm --entrypoint /bin/bash \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  nanoclaw-agent:latest -c '
  export $(cat /workspace/env-dir/env | xargs)
  claude -p "Say hello" --dangerously-skip-permissions --allowedTools ""
'
```

### Interactive shell in container:
```bash
container run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
```

## SDK Options Reference

The agent-runner uses these Claude Agent SDK options:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: '/workspace/group',
    allowedTools: ['Bash', 'Read', 'Write', ...],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,  // Required with bypassPermissions
    settingSources: ['project'],
    mcpServers: { ... }
  }
})
```

**Important:** `allowDangerouslySkipPermissions: true` is required when using `permissionMode: 'bypassPermissions'`. Without it, Claude Code exits with code 1.

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Rebuild container (use --no-cache for clean rebuild)
./container/build.sh

# Or force full rebuild
container builder prune -af
./container/build.sh
```

## Checking Container Image

```bash
# List images
container images

# Check what's in the image
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version

  echo "=== Claude Code version ==="
  claude --version

  echo "=== Installed packages ==="
  ls /app/node_modules/
'
```

## Session Persistence

Claude sessions are stored in `~/.claude/` which is mounted into the container. To clear sessions:

```bash
# Clear all sessions
rm -rf ~/.claude/projects/

# Clear sessions for a specific group
rm -rf ~/.claude/projects/*workspace-group*/
```

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending messages
ls -la data/ipc/messages/

# Check pending task operations
ls -la data/ipc/tasks/

# Read a specific IPC file
cat data/ipc/messages/*.json
```

## Quick Diagnostic Script

Run this to check common issues:

```bash
echo "=== Checking NanoClaw Container Setup ==="

echo -e "\n1. API Key configured?"
[ -f .env ] && grep -q "ANTHROPIC_API_KEY=sk-" .env && echo "OK" || echo "MISSING - create .env with ANTHROPIC_API_KEY"

echo -e "\n2. Env file copied for container?"
[ -f data/env/env ] && echo "OK" || echo "MISSING - will be created on first run"

echo -e "\n3. Container image exists?"
container images 2>/dev/null | grep -q nanoclaw-agent && echo "OK" || echo "MISSING - run ./container/build.sh"

echo -e "\n4. Apple Container running?"
container system info &>/dev/null && echo "OK" || echo "NOT RUNNING - run: container system start"

echo -e "\n5. Groups directory?"
ls -la groups/ 2>/dev/null || echo "MISSING - run setup"

echo -e "\n6. Recent container logs?"
ls -t groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"
```
