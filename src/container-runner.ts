/**
 * Container Runner for Hydra
 * Spawns agent execution in Docker containers and handles IPC
 */
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js';
import { logger } from './logger.js';
import { validateAdditionalMounts } from './mount-security.js';
import { resolveContainerSecrets } from './secrets.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---HYDRA_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HYDRA_OUTPUT_END---';

// Shared credentials source of truth
const SOURCE_CREDENTIALS = path.join(
  process.env.HOME || os.homedir(),
  '.claude',
  '.credentials.json',
);

/**
 * Copy credentials from ~/.claude/ to the group's session dir before spawning.
 * Ensures every container starts with the freshest available token.
 */
export function copyCredentialsToGroup(groupSessionsDir: string): void {
  try {
    if (!fs.existsSync(SOURCE_CREDENTIALS)) return;
    const dest = path.join(groupSessionsDir, '.credentials.json');
    fs.copyFileSync(SOURCE_CREDENTIALS, dest);
    logger.debug({ dest }, 'Copied shared credentials to group session');
  } catch (err) {
    logger.warn({ err }, 'Failed to copy credentials to group session');
  }
}

/**
 * After container exits, write back credentials to ~/.claude/ if the group's
 * copy has a newer expiresAt. This ensures token refreshes propagate back.
 */
export function writeBackCredentialsIfNewer(groupSessionsDir: string): void {
  try {
    const groupCreds = path.join(groupSessionsDir, '.credentials.json');
    if (!fs.existsSync(groupCreds)) return;

    const groupData = JSON.parse(fs.readFileSync(groupCreds, 'utf-8'));
    const groupExpiry = groupData?.claudeAiOauth?.expiresAt ?? 0;

    let sourceExpiry = 0;
    if (fs.existsSync(SOURCE_CREDENTIALS)) {
      const sourceData = JSON.parse(
        fs.readFileSync(SOURCE_CREDENTIALS, 'utf-8'),
      );
      sourceExpiry = sourceData?.claudeAiOauth?.expiresAt ?? 0;
    }

    if (groupExpiry > sourceExpiry) {
      fs.copyFileSync(groupCreds, SOURCE_CREDENTIALS);
      logger.info(
        { groupExpiry, sourceExpiry },
        'Wrote back fresher credentials from container',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to write back credentials');
  }
}

// Verify Docker is available
export function detectContainerRuntime(): 'docker' {
  try {
    // Check if docker command exists and daemon is accessible
    // Pass through DOCKER_HOST env var for remote docker (e.g., docker-proxy)
    const env = process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : undefined;
    execSync('docker version --format "{{.Server.Version}}"', {
      stdio: 'ignore',
      env: env ? { ...process.env, ...env } : process.env,
    });
    logger.debug({ dockerHost: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock' }, 'Docker daemon accessible');
    return 'docker';
  } catch {
    // Last resort: check if docker binary exists (user may have group perms at runtime)
    try {
      execSync('which docker', { stdio: 'ignore' });
      return 'docker';
    } catch {
      throw new Error(
        'No container runtime found. Install Docker: https://docs.docker.com/get-docker/',
      );
    }
  }
}

const CONTAINER_RUNTIME = detectContainerRuntime();
logger.info({ runtime: CONTAINER_RUNTIME }, 'Container runtime detected');

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string }; title?: string };

export interface ContainerInput {
  prompt: string | ContentBlock[];
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/agent',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/agent',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Resolve env vars to inject into a container via -e flags.
 * Uses secrets.env as the source of truth.
 */
export function resolveContainerEnvVars(group: RegisteredGroup): Record<string, string> {
  return resolveContainerSecrets(group.containerConfig?.secrets ?? []);
}

export interface ContainerRunOptions {
  interactive?: boolean;
  entrypoint?: string;
  containerName?: string;
  envVars?: Record<string, string>;
  extraArgs?: string[];
}

export function buildContainerArgs(
  mounts: VolumeMount[],
  containerConfig?: RegisteredGroup['containerConfig'],
  options?: ContainerRunOptions,
): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  if (options?.interactive) {
    args.push('-t');
  }

  if (options?.containerName) {
    args.push('--name', options.containerName);
  }

  if (options?.entrypoint) {
    args.push('--entrypoint', options.entrypoint);
  }

  if (options?.envVars) {
    for (const [key, value] of Object.entries(options.envVars)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Network mode
  if (containerConfig?.networkMode) {
    args.push('--network', containerConfig.networkMode);
  }

  for (const mount of mounts) {
    const mountOpts = `type=bind,source=${mount.hostPath},target=${mount.containerPath}${mount.readonly ? ',readonly' : ''}`;
    args.push('--mount', mountOpts);
  }

  // Use per-group image if specified, otherwise default
  const image = containerConfig?.image || CONTAINER_IMAGE;
  args.push(image);

  // Extra args go after the image name
  if (options?.extraArgs) {
    args.push(...options.extraArgs);
  }

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const containerArgs = buildContainerArgs(mounts, group.containerConfig, {
    envVars: resolveContainerEnvVars(group),
  });

  logger.debug(
    {
      group: group.name,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Sync shared credentials into this group's session before spawning
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  copyCredentialsToGroup(groupSessionsDir);

  return new Promise((resolve) => {
    // Pass DOCKER_HOST to child process for docker-proxy support
    const spawnEnv = process.env.DOCKER_HOST
      ? { ...process.env, DOCKER_HOST: process.env.DOCKER_HOST }
      : process.env;

    const container = spawn(CONTAINER_RUNTIME, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn(
          { group: group.name, size: stdout.length },
          'Container stdout truncated due to size limit',
        );
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing');
      container.kill('SIGKILL');
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${CONTAINER_TIMEOUT}ms`,
      });
    }, group.containerConfig?.timeout || CONTAINER_TIMEOUT);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      // Write back credentials if the container refreshed the token
      writeBackCredentialsIfNewer(groupSessionsDir);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      if (isVerbose) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${typeof input.prompt === 'string' ? input.prompt.length + ' chars' : input.prompt.length + ' content blocks'}`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );

        if (code !== 0) {
          logLines.push(
            `=== Stderr (last 500 chars) ===`,
            stderr.slice(-500),
            ``,
          );
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: stderr.slice(-500),
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout: stdout.slice(-500),
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

// Aliases for exec.ts which uses agent-centric naming
export const copyCredentialsToAgent = copyCredentialsToGroup;
export const getContainerRuntime = detectContainerRuntime;
