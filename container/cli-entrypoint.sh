#!/bin/bash
set -e

# Set OAuth token from mounted credentials file if not already set via env.
# Skip when ANTHROPIC_BASE_URL is set (litellm proxy) — the OAuth token causes
# the SDK to authenticate directly with api.anthropic.com, bypassing the proxy.
if [ -z "$ANTHROPIC_BASE_URL" ] && [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -f "$HOME/.claude/.credentials.json" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN=$(jq -r '.claudeAiOauth.accessToken // empty' "$HOME/.claude/.credentials.json")
fi

# Configure claude-pulse status line + slash commands
mkdir -p "$HOME/.claude/commands"
cp /opt/claude-pulse/commands/*.md "$HOME/.claude/commands/" 2>/dev/null || true

# Create status line wrapper that prepends agent name to claude-pulse output
cat > /tmp/hydra-status.sh << 'STATUSEOF'
#!/bin/bash
agent="${HYDRA_AGENT_NAME:-$HYDRA_AGENT_FOLDER}"

# When LiteLLM is configured, show usage from the stats file written by the Stop hook
if [ -n "$ANTHROPIC_BASE_URL" ]; then
  # If the Stop hook hasn't written stats yet, query LiteLLM directly
  if [ ! -f /tmp/litellm-stats.json ]; then
    lkey="${LITELLM_API_KEY:-$ANTHROPIC_API_KEY}"
    if [ -n "$lkey" ]; then
      info=$(curl -sf -m 3 -H "Authorization: Bearer $lkey" "$ANTHROPIC_BASE_URL/key/info" 2>/dev/null)
      if [ -n "$info" ]; then
        sCost=$(echo "$info" | jq -r '.info.spend // 0' 2>/dev/null)
        budget=$(echo "$info" | jq -r '.info.max_budget // empty' 2>/dev/null)
        costFmt=$(printf '%.4f' "$sCost")
        parts="\$$costFmt"
        [ -n "$budget" ] && parts="$parts / \$$budget"
        echo "$agent | $parts"
        exit 0
      fi
    fi
    echo "$agent"
    exit 0
  fi

  stats=$(cat /tmp/litellm-stats.json 2>/dev/null)
  model=$(echo "$stats" | jq -r '.model // empty' 2>/dev/null)
  sCost=$(echo "$stats" | jq -r '.total.spend // .session.sessionCost // 0' 2>/dev/null)
  budget=$(echo "$stats" | jq -r '.total.maxBudget // empty' 2>/dev/null)
  sTokIn=$(echo "$stats" | jq -r '.session.sessionTokIn // 0' 2>/dev/null)
  sTokOut=$(echo "$stats" | jq -r '.session.sessionTokOut // 0' 2>/dev/null)
  sTok=$((sTokIn + sTokOut))
  costFmt=$(printf '%.4f' "$sCost")
  parts="$model  \$$costFmt"
  [ -n "$budget" ] && parts="$parts / \$$budget"
  parts="$parts  ${sTok} tok (↑${sTokIn} ↓${sTokOut})"
  echo "$agent | $parts"
  exit 0
fi

# Fall back to claude-pulse for non-LiteLLM setups
pulse_output=$(python3 /opt/claude-pulse/claude_status.py 2>/dev/null)
if [ -n "$pulse_output" ]; then
  echo "$agent | $pulse_output"
else
  echo "$agent"
fi
STATUSEOF
chmod +x /tmp/hydra-status.sh

# Clear stale session stats from previous runs
rm -f /tmp/litellm-stats.json

SETTINGS_FILE="$HOME/.claude/settings.json"
SETTINGS_PATCH='{"statusLine": {"type": "command", "command": "bash /tmp/hydra-status.sh", "refresh": 150}}'

# When using LiteLLM (ANTHROPIC_BASE_URL set), provide the API key via
# apiKeyHelper instead of the env var to avoid the "custom API key detected" prompt.
if [ -n "$ANTHROPIC_BASE_URL" ] && [ -n "$ANTHROPIC_API_KEY" ]; then
  cat > /tmp/api-key-helper.sh << KEYEOF
#!/bin/bash
echo "$ANTHROPIC_API_KEY"
KEYEOF
  chmod +x /tmp/api-key-helper.sh
  SETTINGS_PATCH=$(echo "$SETTINGS_PATCH" | jq '. + {"apiKeyHelper": "/tmp/api-key-helper.sh"}')
  # Preserve the key as LITELLM_API_KEY so hooks (litellm-stats) can still query the proxy
  export LITELLM_API_KEY="$ANTHROPIC_API_KEY"
  unset ANTHROPIC_API_KEY
fi

if [ -f "$SETTINGS_FILE" ]; then
  jq --argjson patch "$SETTINGS_PATCH" '. + $patch' \
    "$SETTINGS_FILE" > /tmp/settings-merged.json && mv /tmp/settings-merged.json "$SETTINGS_FILE"
else
  echo "$SETTINGS_PATCH" | jq '.' > "$SETTINGS_FILE"
fi

# Build MCP config for Claude Code CLI
# Start with hydra IPC server (always present)
MCP_SERVERS=$(cat << HYDRA_MCP
    "hydra": {
      "command": "node",
      "args": ["/app/dist/ipc-mcp-stdio.js"],
      "env": {
        "HYDRA_AGENT_FOLDER": "${HYDRA_AGENT_FOLDER}",
        "HYDRA_CHAT_JID": "${HYDRA_CHAT_JID}",
        "HYDRA_IS_MAIN": "${HYDRA_IS_MAIN}"
      }
    }
HYDRA_MCP
)

# Add mem0 MCP server if memory is configured
if [ -n "$MEM0_API_KEY" ] || [ -n "$QDRANT_URL" ]; then
  MEM0_ENV='"HYDRA_AGENT_FOLDER": "'"${HYDRA_AGENT_FOLDER}"'"'
  [ -n "$MEM0_API_KEY" ] && MEM0_ENV="$MEM0_ENV, \"MEM0_API_KEY\": \"${MEM0_API_KEY}\""
  [ -n "$QDRANT_URL" ] && MEM0_ENV="$MEM0_ENV, \"QDRANT_URL\": \"${QDRANT_URL}\""
  [ -n "$OLLAMA_URL" ] && MEM0_ENV="$MEM0_ENV, \"OLLAMA_URL\": \"${OLLAMA_URL}\""
  [ -n "$OPENAI_API_KEY" ] && MEM0_ENV="$MEM0_ENV, \"OPENAI_API_KEY\": \"${OPENAI_API_KEY}\""
  [ -n "$ANTHROPIC_API_KEY" ] && MEM0_ENV="$MEM0_ENV, \"ANTHROPIC_API_KEY\": \"${ANTHROPIC_API_KEY}\""

  MCP_SERVERS="$MCP_SERVERS,
    \"mem0\": {
      \"command\": \"node\",
      \"args\": [\"/app/dist/mem0-mcp-stdio.js\"],
      \"env\": {
        $MEM0_ENV
      }
    }"
fi

cat > /tmp/mcp-config.json << EOF
{
  "mcpServers": {
$MCP_SERVERS
  }
}
EOF

exec claude --dangerously-skip-permissions --mcp-config /tmp/mcp-config.json "$@"
