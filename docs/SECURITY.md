# Hydra Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| External messages (Telegram, web console) | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Docker containers, providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security (Two-File Model)

Mount access is controlled by **two independent config files** that must both agree:

| File | Location | Purpose | Editable by agent? |
|------|----------|---------|-------------------|
| `hydra.yaml` | Project root | Declares what an agent *wants* mounted | Yes (if project root is mounted rw) |
| `mount-allowlist.json` | `~/.config/hydra/` | Declares what's *allowed* to be mounted | No (never mounted into containers) |

**Why two files?** Defense in depth. An agent that gains write access to `hydra.yaml` could add mount entries for sensitive directories. The external allowlist prevents this — it's the runtime enforcement layer that the agent can never reach.

**If the allowlist file doesn't exist, all additional mounts are blocked.** This is a fail-closed design.

**External Allowlist Format** (`~/.config/hydra/mount-allowlist.json`):
```json
{
  "allowedRoots": [
    { "path": "~/src", "allowReadWrite": true, "description": "Source code" }
  ],
  "blockedPatterns": [".ssh", ".gnupg", "credentials"],
  "nonMainReadOnly": true
}
```

**Validation flow** (in `mount-security.ts`):
1. Expand and resolve the host path (including symlinks)
2. Check against blocked patterns — reject if matched
3. Check if the resolved path falls under an `allowedRoot` — reject if not
4. Apply read-only enforcement (per-root `allowReadWrite`, global `nonMainReadOnly`)

**Default Blocked Patterns** (always merged with user-defined patterns):
```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, .pypirc, id_rsa, id_ed25519,
private_key, .secret
```

**Additional Protections:**
- Symlink resolution before validation (prevents traversal via symlinked paths)
- Container path validation (rejects `..` and absolute paths — mounts land under `/workspace/extra/`)
- `nonMainReadOnly` forces read-only for non-main agents even if the root allows read-write

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Mounted Credentials:**
- Claude auth tokens (filtered from `.env`, read-only)

**NOT Mounted:**
- Bot session data - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only these environment variables are exposed to containers:
```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
```

> **Note:** Anthropic credentials are mounted so that Claude Code can authenticate when the agent runs. However, this means the agent itself can discover these credentials via Bash or file operations. Ideally, Claude Code would authenticate without exposing credentials to the agent's execution environment, but I couldn't figure this out. **PRs welcome** if you have ideas for credential isolation.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  External Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
