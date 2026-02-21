/**
 * hydra exec — Interactive Claude Code session in agent containers
 *
 * Usage:
 *   hydra exec main                  # interactive session as main agent
 *   hydra exec merlin                # interactive session as merlin
 *   hydra exec main --continue       # resume last session
 *   hydra exec main --resume <id>    # resume specific session
 */

import 'dotenv/config';
import { spawnSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadHydraConfig, toLegacyRegisteredAgents } from '../../hydra-config.js';
import {
  buildVolumeMounts,
  buildContainerArgs,
  copyCredentialsToAgent,
  writeBackCredentialsIfNewer,
  getContainerRuntime,
  rewriteUrlForContainer,
} from '../../container-runner.js';
import { DATA_DIR, AGENTS_DIR } from '../../config.js';
import { resolveContainerSecrets, resolveSecretRef } from '../../secrets.js';
import { printSessionSummary } from '../../litellm-stats.js';

export async function run(args: string[]): Promise<void> {
  // First arg is the agent folder name, everything after is passed to claude
  const folderName = args[0];
  const claudeArgs = args.slice(1);

  if (!folderName) {
    console.error('Usage: hydra exec <agent-folder> [<claude-args>...]');
    console.error('');

    // List available agents
    try {
      const config = loadHydraConfig();
      if (config.agents.length > 0) {
        console.error('Available agents:');
        for (const agent of config.agents) {
          console.error(`  ${agent.folder.padEnd(20)} ${agent.name}`);
        }
      }
    } catch {
      // If config fails, check agents/ directory
      if (fs.existsSync(AGENTS_DIR)) {
        const dirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => d.name);
        if (dirs.length > 0) {
          console.error('Available agent folders:');
          for (const dir of dirs) {
            console.error(`  ${dir}`);
          }
        }
      }
    }
    process.exit(1);
  }

  // Load config and find agent
  let config;
  try {
    config = loadHydraConfig();
  } catch (err) {
    console.error('Failed to load hydra config:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Find agent by folder name or agent name
  const agent = config.agents.find(
    a => a.folder === folderName || a.name.toLowerCase() === folderName.toLowerCase(),
  );

  if (!agent) {
    console.error(`Agent "${folderName}" not found.`);
    console.error('');
    if (config.agents.length > 0) {
      console.error('Available agents:');
      for (const a of config.agents) {
        console.error(`  ${a.folder.padEnd(20)} ${a.name}`);
      }
    }
    process.exit(1);
  }

  const isMain = agent.folder === 'main';
  const runtime = getContainerRuntime();
  const containerName = `hydra-cli-${agent.folder}`;

  // Check for existing CLI container
  try {
    const env = process.env.DOCKER_HOST
      ? { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST }
      : process.env;
    const existing = execSync(
      `${runtime} ps --filter name=${containerName} --format "{{.Names}}"`,
      { encoding: 'utf-8', env },
    ).trim();
    if (existing) {
      console.error(`Container "${containerName}" is already running.`);
      console.error(`Attach with: ${runtime} exec -it ${containerName} bash`);
      process.exit(1);
    }
  } catch {
    // ps command failed — likely no running container, continue
  }

  // Ensure agent directory exists
  const agentDir = path.join(AGENTS_DIR, agent.folder);
  fs.mkdirSync(agentDir, { recursive: true });

  // Convert agent to RegisteredAgent format for buildVolumeMounts
  const legacyAgents = toLegacyRegisteredAgents(config);
  const legacyAgent = Object.values(legacyAgents).find(a => a.folder === agent.folder);

  if (!legacyAgent) {
    console.error(`Could not resolve agent "${agent.folder}" to a registered agent.`);
    process.exit(1);
  }

  // Copy credentials and settings before spawning.
  // Skip when LiteLLM is configured — the OAuth token in credentials causes
  // Claude Code to authenticate directly with api.anthropic.com, bypassing the proxy.
  const agentSessionsDir = path.join(DATA_DIR, 'sessions', agent.folder, '.claude');
  fs.mkdirSync(agentSessionsDir, { recursive: true });
  const effectiveLlmForCreds = agent.llm ?? config.llm;
  if (effectiveLlmForCreds?.provider === 'litellm') {
    // Remove stale credentials so Claude Code doesn't pick up the OAuth token
    const credsDest = path.join(agentSessionsDir, '.credentials.json');
    try { fs.unlinkSync(credsDest); } catch { /* not present */ }
  } else {
    copyCredentialsToAgent(agentSessionsDir);
  }

  // Copy Claude Code config (~/.claude.json) which stores hasCompletedOnboarding, theme, etc.
  // Without this, Claude Code shows the first-time onboarding wizard.
  const homeDir = process.env.HOME || os.homedir();
  const hostConfigJson = path.join(homeDir, '.claude.json');
  const agentConfigJson = path.join(DATA_DIR, 'sessions', agent.folder, '.claude.json');
  if (fs.existsSync(hostConfigJson)) {
    fs.copyFileSync(hostConfigJson, agentConfigJson);
  }

  // Resolve secrets from ~/.config/hydra/secrets.env
  const envVars: Record<string, string> = {
    ...resolveContainerSecrets(agent.container?.secrets ?? []),
    HYDRA_AGENT_FOLDER: agent.folder,
    HYDRA_AGENT_NAME: agent.name,
    HYDRA_CHAT_JID: `cli:local:${agent.folder}`,
    HYDRA_IS_MAIN: String(isMain),
  };

  // Set default model from agent config (overridable via --model flag)
  if (agent.model) {
    envVars.ANTHROPIC_MODEL = agent.model;
  }

  const networkMode = agent.container?.network_mode || 'bridge';

  // Rewrite localhost URLs to host.docker.internal for bridge-mode containers
  if (networkMode !== 'host') {
    if (envVars.QDRANT_URL) envVars.QDRANT_URL = rewriteUrlForContainer(envVars.QDRANT_URL);
    if (envVars.OLLAMA_URL) envVars.OLLAMA_URL = rewriteUrlForContainer(envVars.OLLAMA_URL);
  }

  // Inject LiteLLM env vars (per-agent overrides global)
  const effectiveLlm = agent.llm ?? config.llm;
  if (effectiveLlm?.provider === 'litellm' && effectiveLlm.base_url) {
    envVars.ANTHROPIC_BASE_URL = networkMode === 'host'
      ? effectiveLlm.base_url
      : rewriteUrlForContainer(effectiveLlm.base_url);
  }
  if (effectiveLlm?.api_key) {
    envVars.ANTHROPIC_API_KEY = resolveSecretRef(effectiveLlm.api_key);
  }

  // Set up LiteLLM usage display: Stop hook (per-request) + settings injection
  const sessionStart = new Date();
  if (effectiveLlm?.provider === 'litellm' && effectiveLlm.base_url) {
    setupLiteLLMHook(agentSessionsDir);
    envVars.HYDRA_SESSION_START = sessionStart.toISOString();
  }

  // Override OAuth token from credentials file (freshest source).
  // Skip when LiteLLM is configured — the OAuth token causes the Claude SDK to
  // authenticate directly with api.anthropic.com, bypassing ANTHROPIC_BASE_URL entirely.
  if (effectiveLlm?.provider !== 'litellm') {
    const credentialsPath = path.join(
      process.env.HOME || os.homedir(),
      '.claude',
      '.credentials.json',
    );
    try {
      if (fs.existsSync(credentialsPath)) {
        const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
        const token = creds?.claudeAiOauth?.accessToken;
        if (token) {
          envVars.CLAUDE_CODE_OAUTH_TOKEN = token;
        }
      }
    } catch {
      // Fall through — credentials file missing or invalid
    }
  } else {
    // Ensure the token from secrets.env doesn't leak through either
    delete envVars.CLAUDE_CODE_OAUTH_TOKEN;
  }

  // Build volume mounts and container args
  const mounts = buildVolumeMounts(legacyAgent, isMain);

  // Mount .claude.json (Claude Code config) into container home
  if (fs.existsSync(agentConfigJson)) {
    mounts.push({
      hostPath: agentConfigJson,
      containerPath: '/home/node/.claude.json',
      readonly: false,
    });
  }

  const containerArgs = buildContainerArgs(mounts, legacyAgent.containerConfig, {
    interactive: true,
    entrypoint: '/app/cli-entrypoint.sh',
    containerName,
    envVars,
    extraArgs: claudeArgs.length > 0 ? claudeArgs : undefined,
  });

  console.log(`Starting Claude Code session for agent "${agent.name}" (${agent.folder})...`);

  // Spawn with stdio inherit — user's TTY passes through
  const spawnEnv = process.env.DOCKER_HOST
    ? { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST }
    : process.env;

  const result = spawnSync(runtime, containerArgs, {
    stdio: 'inherit',
    env: spawnEnv,
  });

  // Write back credentials if the container refreshed the token
  writeBackCredentialsIfNewer(agentSessionsDir);

  // Post-session LiteLLM cost summary (runs on the host, uses the raw URL without rewriting)
  if (effectiveLlm?.provider === 'litellm' && effectiveLlm.base_url) {
    const apiKey = (effectiveLlm.api_key ? resolveSecretRef(effectiveLlm.api_key) : null)
      ?? envVars.LITELLM_API_KEY
      ?? envVars.ANTHROPIC_API_KEY
      ?? '';
    if (apiKey) {
      await printSessionSummary(effectiveLlm.base_url, apiKey, sessionStart);
    }
  }

  process.exit(result.status ?? 1);
}

// Hook script source lives in resources/litellm-hook.mjs (copied to dist/ at build time).
const LITELLM_HOOK_SCRIPT = fs.readFileSync(
  new URL('./resources/litellm-hook.mjs', import.meta.url),
  'utf-8',
);

/**
 * Write the LiteLLM hook script and inject a Stop hook into Claude Code's settings.json.
 * Idempotent — safe to call on every exec.
 */
function setupLiteLLMHook(sessionsDir: string): void {
  // Write the hook script
  const scriptPath = path.join(sessionsDir, 'litellm-stats.mjs');
  fs.writeFileSync(scriptPath, LITELLM_HOOK_SCRIPT, { mode: 0o755 });

  // The path as seen inside the container (sessionsDir is mounted at /home/node/.claude/)
  const containerScriptPath = '/home/node/.claude/litellm-stats.mjs';
  const hookCmd = `node ${containerScriptPath}`;

  // Merge into existing settings.json
  const settingsPath = path.join(sessionsDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch { /* keep empty */ }
  }

  type HookEntry = { hooks: Array<{ type: string; command: string }> };
  const hooks = (settings.hooks as Record<string, HookEntry[]> | undefined) ?? {};
  const stopList: HookEntry[] = (hooks.Stop as HookEntry[]) ?? [];

  // Idempotent — only add if not already present
  if (!stopList.some(h => h.hooks?.some(hh => hh.command === hookCmd))) {
    stopList.push({ hooks: [{ type: 'command', command: hookCmd }] });
  }

  settings.hooks = { ...hooks, Stop: stopList };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
