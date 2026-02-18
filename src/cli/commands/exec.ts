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
} from '../../container-runner.js';
import { DATA_DIR, AGENTS_DIR } from '../../config.js';
import { resolveContainerSecrets } from '../../secrets.js';

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

  // Copy credentials and settings before spawning
  const agentSessionsDir = path.join(DATA_DIR, 'sessions', agent.folder, '.claude');
  fs.mkdirSync(agentSessionsDir, { recursive: true });
  copyCredentialsToAgent(agentSessionsDir);

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
    HYDRA_CHAT_JID: `cli:local:${agent.folder}`,
    HYDRA_IS_MAIN: String(isMain),
  };

  // Set default model from agent config (overridable via --model flag)
  if (agent.model) {
    envVars.ANTHROPIC_MODEL = agent.model;
  }

  // Rewrite localhost/internal URLs to host.docker.internal for bridge-mode containers
  const networkMode = agent.container?.network_mode || 'bridge';
  if (networkMode !== 'host') {
    const rewriteUrl = (url: string): string => {
      try {
        const parsed = new URL(url);
        const internalHosts = ['qdrant', 'ollama', 'localhost', '127.0.0.1'];
        if (internalHosts.includes(parsed.hostname)) {
          parsed.hostname = 'host.docker.internal';
          return parsed.toString().replace(/\/$/, '');
        }
      } catch { /* not a URL, pass through */ }
      return url;
    };
    if (envVars.QDRANT_URL) envVars.QDRANT_URL = rewriteUrl(envVars.QDRANT_URL);
    if (envVars.OLLAMA_URL) envVars.OLLAMA_URL = rewriteUrl(envVars.OLLAMA_URL);
  }

  // Override OAuth token from credentials file (freshest source)
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

  process.exit(result.status ?? 1);
}
