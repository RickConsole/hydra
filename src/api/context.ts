/**
 * API Context Provider
 *
 * Wires the API server to actual Hydra functionality.
 * This module bridges the HTTP/WS API with the core orchestrator.
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  HydraConfigSchema,
  loadHydraConfig,
  type HydraConfig,
} from '../hydra-config.js';
import {
  DATA_DIR,
  loadRegisteredGroups,
  isUsingUnifiedConfig,
} from '../config.js';
import type { RegisteredGroup } from '../types.js';
import type { Agent } from './server.js';
import { logger } from '../logger.js';

// In-memory state tracking for agents
interface AgentState {
  status: 'running' | 'stopped' | 'error' | 'starting';
  startedAt?: Date;
  lastError?: string;
}

const agentStates = new Map<string, AgentState>();

// Log buffer for streaming logs
const logBuffer: string[] = [];
const MAX_LOG_LINES = 1000;

export function appendLog(line: string): void {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }
}

// Helper to get config file path
function getConfigPath(): string {
  // Check common locations for hydra.yaml
  const candidates = [
    path.join(process.cwd(), 'hydra.yaml'),
    path.join(process.cwd(), 'hydra.json'),
    path.join(DATA_DIR, '..', 'hydra.yaml'),
    path.join(DATA_DIR, '..', 'hydra.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to hydra.yaml in cwd
  return path.join(process.cwd(), 'hydra.yaml');
}

// Get raw config content and parsed object
export function getConfig(): { raw: string; parsed: unknown } {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    // Return empty config if no file exists
    const emptyConfig: HydraConfig = {
      version: '1',
      bots: {},
      agents: [],
      security: {},
    };
    return {
      raw: stringifyYaml(emptyConfig),
      parsed: emptyConfig,
    };
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = loadHydraConfig(configPath);
  return { raw, parsed };
}

// Validate config content without saving
export function validateConfig(
  content: string
): { valid: boolean; errors?: Array<{ path: string; message: string }> } {
  try {
    const data = parseYaml(content);
    const result = HydraConfigSchema.safeParse(data);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return { valid: false, errors };
    }

    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      errors: [{ path: '', message: err instanceof Error ? err.message : 'Parse error' }],
    };
  }
}

// Update config file
export async function updateConfig(
  content: string
): Promise<{ success: boolean; errors?: Array<{ path: string; message: string }> }> {
  // First validate
  const validation = validateConfig(content);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  // Write to file
  const configPath = getConfigPath();
  try {
    // Create backup
    if (fs.existsSync(configPath)) {
      const backupPath = configPath + '.bak';
      fs.copyFileSync(configPath, backupPath);
    }

    fs.writeFileSync(configPath, content, 'utf-8');
    logger.info({ path: configPath }, 'Config updated');

    return { success: true };
  } catch (err) {
    logger.error({ err, path: configPath }, 'Failed to write config');
    return {
      success: false,
      errors: [{ path: '', message: err instanceof Error ? err.message : 'Write error' }],
    };
  }
}

// Get list of agents from config
export function getAgents(): Agent[] {
  const groups = loadRegisteredGroups();
  const agents: Agent[] = [];

  for (const [jid, group] of Object.entries(groups)) {
    // Extract platform from JID (telegram:bot:chatid -> telegram)
    const platform = jid.split(':')[0] || 'unknown';

    // Get or create state
    let state = agentStates.get(group.folder);
    if (!state) {
      state = { status: 'stopped' };
      agentStates.set(group.folder, state);
    }

    agents.push({
      id: group.folder,
      name: group.name,
      status: state.status,
      platform,
      groupFolder: group.folder,
      uptime: state.startedAt
        ? Math.floor((Date.now() - state.startedAt.getTime()) / 1000)
        : undefined,
    });
  }

  return agents;
}

// Agent lifecycle management
// Note: These are placeholders - actual implementation depends on container management
export async function startAgent(agentId: string): Promise<void> {
  const state = agentStates.get(agentId) || { status: 'stopped' };
  state.status = 'starting';
  agentStates.set(agentId, state);

  // Simulate startup delay
  await new Promise((resolve) => setTimeout(resolve, 500));

  state.status = 'running';
  state.startedAt = new Date();
  agentStates.set(agentId, state);

  logger.info({ agentId }, 'Agent started');
}

export async function stopAgent(agentId: string): Promise<void> {
  const state = agentStates.get(agentId) || { status: 'stopped' };
  state.status = 'stopped';
  state.startedAt = undefined;
  agentStates.set(agentId, state);

  logger.info({ agentId }, 'Agent stopped');
}

export async function restartAgent(agentId: string): Promise<void> {
  await stopAgent(agentId);
  await startAgent(agentId);
}

// Chat with agent
// Note: This is a placeholder - actual implementation needs to invoke the container
export async function sendChatMessage(agentId: string, message: string): Promise<string> {
  logger.info({ agentId, messageLength: message.length }, 'Chat message received');

  // Placeholder response
  // In real implementation, this would:
  // 1. Find the agent's group folder
  // 2. Build the prompt
  // 3. Call runContainerAgent
  // 4. Return the response

  return `[Placeholder] Agent "${agentId}" received: "${message.slice(0, 50)}..."`;
}

// Memory operations
// Note: These are placeholders - actual implementation depends on mem0 integration
export async function getMemories(
  agentId: string
): Promise<Array<{ id: string; content: string; createdAt: string }>> {
  // Placeholder - would query mem0
  return [];
}

export async function searchMemories(
  agentId: string,
  query: string
): Promise<Array<{ id: string; content: string; createdAt: string }>> {
  // Placeholder - would search mem0
  return [];
}

export async function deleteMemory(agentId: string, memoryId: string): Promise<void> {
  // Placeholder - would delete from mem0
  logger.info({ agentId, memoryId }, 'Memory deleted');
}

// Get logs
export function getLogs(agentId?: string, lines: number = 100): string[] {
  // Filter by agent if specified
  let logs = [...logBuffer];

  if (agentId) {
    logs = logs.filter((line) => line.includes(agentId));
  }

  // Return last N lines
  return logs.slice(-lines);
}

// Create the full API context
export function createApiContext() {
  return {
    getAgents,
    getConfig,
    updateConfig,
    validateConfig,
    sendChatMessage,
    startAgent,
    stopAgent,
    restartAgent,
    getMemories,
    searchMemories,
    deleteMemory,
    getLogs,
  };
}
