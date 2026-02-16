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
  MAIN_GROUP_FOLDER,
} from '../config.js';
import type { RegisteredGroup } from '../types.js';
import type { Agent, AgentStatus, ScheduledTask } from './server.js';
import { getAllTasks, pauseTask as dbPauseTask, resumeTask as dbResumeTask, deleteTask as dbDeleteTask, getTask as dbGetTask } from '../db.js';
import { logger } from '../logger.js';
import { runContainerAgent, writeGroupsSnapshot, writeTasksSnapshot } from '../container-runner.js';

// In-memory state tracking for agents
interface AgentState {
  status: AgentStatus;
  lastActive?: Date;
  activeContainers: number;
  requestsToday: number;
  totalRequests: number;
  totalResponseTime: number; // for calculating average
  lastError?: string;
}

const agentStates = new Map<string, AgentState>();

// Get or create agent state
function getAgentState(agentId: string): AgentState {
  let state = agentStates.get(agentId);
  if (!state) {
    state = {
      status: 'ready',
      activeContainers: 0,
      requestsToday: 0,
      totalRequests: 0,
      totalResponseTime: 0,
    };
    agentStates.set(agentId, state);
  }
  return state;
}

// Update agent state when processing starts
export function markAgentProcessing(agentId: string): void {
  const state = getAgentState(agentId);
  state.status = 'processing';
  state.activeContainers++;
  agentStates.set(agentId, state);
}

// Update agent state when processing ends
export function markAgentReady(agentId: string, responseTimeMs: number, error?: string): void {
  const state = getAgentState(agentId);
  state.activeContainers = Math.max(0, state.activeContainers - 1);
  state.status = state.activeContainers > 0 ? 'processing' : (error ? 'error' : 'ready');
  state.lastActive = new Date();
  state.requestsToday++;
  state.totalRequests++;
  state.totalResponseTime += responseTimeMs;
  if (error) {
    state.lastError = error;
  }
  agentStates.set(agentId, state);
}

// Log buffer for streaming logs
const logBuffer: string[] = [];
const MAX_LOG_LINES = 1000;

export function appendLog(line: string): void {
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.shift();
  }
}

// Dependencies injected from main orchestrator
interface ContextDependencies {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSessions: (sessions: Record<string, string>) => void;
}

let deps: ContextDependencies | null = null;

/**
 * Initialize context with dependencies from the orchestrator
 */
export function initContext(dependencies: ContextDependencies): void {
  deps = dependencies;
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
  const groups = deps?.getRegisteredGroups() || loadRegisteredGroups();
  const agents: Agent[] = [];

  for (const [jid, group] of Object.entries(groups)) {
    // Extract platform from JID (telegram:bot:chatid -> telegram, web:console:folder -> web)
    const platform = jid.split(':')[0] || 'unknown';

    // Get or create state
    const state = getAgentState(group.folder);

    agents.push({
      id: group.folder,
      name: group.name,
      status: state.status,
      platform,
      groupFolder: group.folder,
      lastActive: state.lastActive,
      activeContainers: state.activeContainers,
      stats: state.totalRequests > 0 ? {
        requestsToday: state.requestsToday,
        avgResponseTime: state.totalResponseTime / state.totalRequests / 1000, // convert to seconds
        totalRequests: state.totalRequests,
      } : undefined,
      lastError: state.lastError,
    });
  }

  return agents;
}

// Find group by folder name
function findGroupByFolder(folder: string): { jid: string; group: RegisteredGroup } | null {
  const groups = deps?.getRegisteredGroups() || loadRegisteredGroups();

  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === folder) {
      return { jid, group };
    }
  }

  return null;
}

// Agent lifecycle management
// Note: In Hydra, ephemeral agents are always "ready" - these functions are no-ops
// but kept for API compatibility. The actual status is managed by markAgentProcessing/markAgentReady.
export async function startAgent(agentId: string): Promise<void> {
  // No-op for ephemeral agents - they're always ready
  logger.info({ agentId }, 'Agent start requested (no-op for ephemeral agents)');
}

export async function stopAgent(agentId: string): Promise<void> {
  // No-op for ephemeral agents
  logger.info({ agentId }, 'Agent stop requested (no-op for ephemeral agents)');
}

export async function restartAgent(agentId: string): Promise<void> {
  // No-op for ephemeral agents
  logger.info({ agentId }, 'Agent restart requested (no-op for ephemeral agents)');
}

/**
 * Send a chat message to an agent and get a response
 * This actually invokes the container agent
 */
export async function sendChatMessage(agentId: string, message: string): Promise<string> {
  const match = findGroupByFolder(agentId);
  if (!match) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  const { jid, group } = match;
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessions = deps?.getSessions() || {};
  const sessionId = sessions[group.folder];
  const registeredGroups = deps?.getRegisteredGroups() || loadRegisteredGroups();

  logger.info({ agentId, jid, isMain, hasSession: !!sessionId }, 'Sending chat message to agent');

  // Mark agent as processing
  markAgentProcessing(agentId);
  const startTime = Date.now();

  try {
    // Build the prompt in the expected format
    const timestamp = new Date().toISOString();
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const prompt = `<messages>\n<message sender="WebConsole" time="${timestamp}">${escapeXml(message)}</message>\n</messages>`;

    // Update tasks snapshot for container to read
    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    // Write groups snapshot
    writeGroupsSnapshot(
      group.folder,
      isMain,
      [],
      new Set(Object.keys(registeredGroups)),
    );

    // Run the container agent
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: `web:console:${agentId}`, // JID for web console chat
      isMain,
    });

    // Update session if we got a new one
    if (output.newSessionId && deps) {
      const updatedSessions = { ...deps.getSessions(), [group.folder]: output.newSessionId };
      deps.setSessions(updatedSessions);
    }

    const responseTime = Date.now() - startTime;

    if (output.status === 'error') {
      markAgentReady(agentId, responseTime, output.error);
      logger.error({ agentId, error: output.error }, 'Agent returned error');
      throw new Error(output.error || 'Agent error');
    }

    markAgentReady(agentId, responseTime);
    return output.result || '';
  } catch (err) {
    const responseTime = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    markAgentReady(agentId, responseTime, errorMsg);
    throw err;
  }
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

// Scheduled task functions
export function getTasks(): ScheduledTask[] {
  const dbTasks = getAllTasks();
  return dbTasks.map((t) => ({
    id: t.id,
    agentId: t.group_folder,
    prompt: t.prompt,
    scheduleType: t.schedule_type as ScheduledTask['scheduleType'],
    scheduleValue: t.schedule_value,
    status: t.status as ScheduledTask['status'],
    nextRun: t.next_run ? new Date(t.next_run) : undefined,
    lastRun: t.last_run ? new Date(t.last_run) : undefined,
    lastRunStatus: t.last_run_status as ScheduledTask['lastRunStatus'],
    lastError: t.last_error || undefined,
    createdAt: new Date(t.created_at),
  }));
}

export function getTask(taskId: string): ScheduledTask | undefined {
  const t = dbGetTask(taskId);
  if (!t) return undefined;

  return {
    id: t.id,
    agentId: t.group_folder,
    prompt: t.prompt,
    scheduleType: t.schedule_type as ScheduledTask['scheduleType'],
    scheduleValue: t.schedule_value,
    status: t.status as ScheduledTask['status'],
    nextRun: t.next_run ? new Date(t.next_run) : undefined,
    lastRun: t.last_run ? new Date(t.last_run) : undefined,
    lastRunStatus: t.last_run_status as ScheduledTask['lastRunStatus'],
    lastError: t.last_error || undefined,
    createdAt: new Date(t.created_at),
  };
}

export async function pauseTask(taskId: string): Promise<void> {
  dbPauseTask(taskId);
  logger.info({ taskId }, 'Task paused');
}

export async function resumeTask(taskId: string): Promise<void> {
  dbResumeTask(taskId);
  logger.info({ taskId }, 'Task resumed');
}

export async function cancelTask(taskId: string): Promise<void> {
  dbDeleteTask(taskId);
  logger.info({ taskId }, 'Task cancelled');
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
    // Task methods
    getTasks,
    getTask,
    pauseTask,
    resumeTask,
    cancelTask,
  };
}
