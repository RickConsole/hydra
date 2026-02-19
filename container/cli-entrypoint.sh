#!/bin/bash
set -e

# Set OAuth token from mounted credentials file if not already set via env
if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -f "$HOME/.claude/.credentials.json" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN=$(jq -r '.claudeAiOauth.accessToken // empty' "$HOME/.claude/.credentials.json")
fi

# Configure claude-pulse status line + slash commands
mkdir -p "$HOME/.claude/commands"
cp /opt/claude-pulse/commands/*.md "$HOME/.claude/commands/" 2>/dev/null || true

# Create status line wrapper that prepends agent name to claude-pulse output
cat > /tmp/hydra-status.sh << 'STATUSEOF'
#!/bin/bash
pulse_output=$(python3 /opt/claude-pulse/claude_status.py 2>/dev/null)
agent="${HYDRA_AGENT_NAME:-$HYDRA_AGENT_FOLDER}"
if [ -n "$pulse_output" ]; then
  echo "$agent | $pulse_output"
else
  echo "$agent"
fi
STATUSEOF
chmod +x /tmp/hydra-status.sh

SETTINGS_FILE="$HOME/.claude/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  # Merge statusLine into existing settings
  jq '. + {"statusLine": {"type": "command", "command": "bash /tmp/hydra-status.sh", "refresh": 150}}' \
    "$SETTINGS_FILE" > /tmp/settings-merged.json && mv /tmp/settings-merged.json "$SETTINGS_FILE"
else
  cat > "$SETTINGS_FILE" << 'SETTINGS'
{
  "statusLine": {
    "type": "command",
    "command": "bash /tmp/hydra-status.sh",
    "refresh": 150
  }
}
SETTINGS
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
