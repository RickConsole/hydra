/**
 * Container Runner for NanoClaw
 * Spawns agent execution in Apple Container and handles IPC
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  GROUPS_DIR,
  DATA_DIR
} from './config.js';
import { RegisteredGroup } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
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

function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = process.env.HOME || '/Users/gavriel';

  // Group's working directory (read-write)
  mounts.push({
    hostPath: path.join(GROUPS_DIR, group.folder),
    containerPath: '/workspace/group',
    readonly: false
  });

  // Global CLAUDE.md (read-only for non-main, read-write for main)
  const globalClaudeMd = path.join(GROUPS_DIR, 'CLAUDE.md');
  if (fs.existsSync(globalClaudeMd)) {
    mounts.push({
      hostPath: globalClaudeMd,
      containerPath: '/workspace/global/CLAUDE.md',
      readonly: !isMain
    });
  }

  // Claude sessions directory (for session persistence)
  const claudeDir = path.join(homeDir, '.claude');
  if (fs.existsSync(claudeDir)) {
    mounts.push({
      hostPath: claudeDir,
      containerPath: '/root/.claude',
      readonly: false
    });
  }

  // Gmail MCP credentials
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/root/.gmail-mcp',
      readonly: false
    });
  }

  // IPC directory for messages and tasks
  const ipcDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: ipcDir,
    containerPath: '/workspace/ipc',
    readonly: false
  });

  // Additional mounts from group config
  if (group.containerConfig?.additionalMounts) {
    for (const mount of group.containerConfig.additionalMounts) {
      // Resolve home directory in path
      const hostPath = mount.hostPath.startsWith('~')
        ? path.join(homeDir, mount.hostPath.slice(1))
        : mount.hostPath;

      if (fs.existsSync(hostPath)) {
        mounts.push({
          hostPath,
          containerPath: `/workspace/extra/${mount.containerPath}`,
          readonly: mount.readonly !== false // Default to readonly for safety
        });
      } else {
        logger.warn({ hostPath }, 'Additional mount path does not exist, skipping');
      }
    }
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[]): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  // Add volume mounts
  for (const mount of mounts) {
    const mode = mount.readonly ? ':ro' : '';
    args.push('-v', `${mount.hostPath}:${mount.containerPath}${mode}`);
  }

  // Add the image name
  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput
): Promise<ContainerOutput> {
  const startTime = Date.now();

  // Ensure group directory exists
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Build volume mounts
  const mounts = buildVolumeMounts(group, input.isMain);
  const containerArgs = buildContainerArgs(mounts);

  logger.info({
    group: group.name,
    mountCount: mounts.length,
    isMain: input.isMain
  }, 'Spawning container agent');

  return new Promise((resolve) => {
    const container = spawn('container', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    // Send input JSON to container stdin
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    container.stderr.on('data', (data) => {
      stderr += data.toString();
      // Log container stderr in real-time
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
    });

    // Timeout handler
    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing');
      container.kill('SIGKILL');
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${CONTAINER_TIMEOUT}ms`
      });
    }, group.containerConfig?.timeout || CONTAINER_TIMEOUT);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (code !== 0) {
        logger.error({
          group: group.name,
          code,
          duration,
          stderr: stderr.slice(-500)
        }, 'Container exited with error');

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`
        });
        return;
      }

      // Parse JSON output from stdout
      try {
        // Find the JSON line (last non-empty line should be the output)
        const lines = stdout.trim().split('\n');
        const jsonLine = lines[lines.length - 1];
        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info({
          group: group.name,
          duration,
          status: output.status,
          hasResult: !!output.result
        }, 'Container completed');

        resolve(output);
      } catch (err) {
        logger.error({
          group: group.name,
          stdout: stdout.slice(-500),
          error: err
        }, 'Failed to parse container output');

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`
      });
    });
  });
}

// Export task snapshot for container IPC
export function writeTasksSnapshot(tasks: Array<{
  id: string;
  groupFolder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}>): void {
  const ipcDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcDir, { recursive: true });
  const tasksFile = path.join(ipcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
}
