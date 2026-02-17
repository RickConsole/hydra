# Wardgate Integration

## Overview

[Wardgate](https://github.com/wardgate/wardgate) is an open-source security gateway that mediates between AI agents and external systems. It provides credential isolation and policy enforcement.

## Why Wardgate for Hydra

Hydra already has container isolation for agents. Wardgate adds another layer:
- **Credential isolation** - Agents never see raw API keys
- **Policy enforcement** - Granular per-agent permissions
- **Audit logging** - Track all external API calls
- **Approval workflows** - Require human approval for sensitive operations

## Architecture

### Current (Without Wardgate)
```
User → Console → Orchestrator → Container Agent → MCP Tools → External APIs
                                                            ↓
                                              (direct access with raw credentials)
```

### With Wardgate
```
User → Console → Orchestrator → Container Agent → Wardgate → External APIs
                                      ↓                ↓
                              (no raw credentials)  (credentials injected here)
                                      ↓                ↓
                              Policy evaluation   Audit logging
```

## Integration Points

### 1. Docker Compose Addition
```yaml
services:
  wardgate:
    image: wardgate/wardgate:latest
    restart: unless-stopped
    volumes:
      - ./wardgate.yaml:/etc/wardgate/config.yaml:ro
      - wardgate_credentials:/var/lib/wardgate/credentials
    networks:
      - hydra-internal
    # Only orchestrator/agents can reach wardgate
    security_opt:
      - no-new-privileges:true

volumes:
  wardgate_credentials:
    driver: local
```

### 2. Replace Direct API Access

Instead of passing API keys to containers, agents use `wardgate-cli`:

**Before:**
```bash
curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/...
```

**After:**
```bash
wardgate-cli github /repos/owner/repo/pulls
```

### 3. Move Credentials to Wardgate

All API keys move from `.env` to Wardgate's credential store:
- GitHub token
- OpenAI/Anthropic keys (if used directly)
- Any third-party service credentials

Agent containers only get `WARDGATE_URL` - no raw API keys.

### 4. Policy Configuration

```yaml
# wardgate.yaml
agents:
  main:
    # Full access for main/admin agent
    github:
      - action: allow
        methods: ["*"]
        paths: ["*"]
    filesystem:
      - action: allow
        paths: ["/workspace/**"]
        operations: [read, write]
      - action: deny
        paths: ["~/.ssh/**", "~/.aws/**", "~/.config/hydra/**"]

  support:
    # Limited access for support agents
    github:
      - action: allow
        methods: [GET]
        paths: ["/repos/*/issues", "/repos/*/pulls"]
      - action: deny
        methods: [DELETE, PUT]
    filesystem:
      - action: allow
        paths: ["/workspace/docs/**"]
        operations: [read]
      - action: deny
        operations: [write, delete]

  # Default policy for unspecified agents
  default:
    - action: ask  # Require approval
```

### 5. Container Configuration Update

Update container-runner to:
1. NOT pass raw API keys to containers
2. Pass `WARDGATE_URL=http://wardgate:8080` instead
3. Include `wardgate-cli` in the agent container image

## Security Benefits

| Layer | Protection |
|-------|-----------|
| Container isolation | Agent can't access host filesystem directly |
| Mount allowlist | Limits what directories can be mounted |
| Docker socket proxy | Limits container operations |
| **Wardgate** | Limits external API access, hides credentials |

## Implementation Steps

- [ ] Add Wardgate to docker-compose.yml
- [ ] Create wardgate.yaml with default policies
- [ ] Add wardgate-cli to agent container image
- [ ] Update container-runner to pass WARDGATE_URL instead of API keys
- [ ] Migrate credentials from .env to Wardgate
- [ ] Update agent CLAUDE.md files to use wardgate-cli
- [ ] Add audit log viewer to Hydra Console
- [ ] Test policy enforcement

## Conclaves (Future)

Wardgate also supports "Conclaves" - isolated execution environments. These could potentially:
- Replace Hydra's container isolation
- Provide additional sandboxing
- Enable cross-machine agent deployment

For now, keep Hydra's containers and use Wardgate purely as API gateway.

## References

- [Wardgate GitHub](https://github.com/wardgate/wardgate)
- [Wardgate Docs](https://wardgate.dev/docs)
