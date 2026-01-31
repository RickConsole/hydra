import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById } from './db.js';
import { createSchedulerMcp } from './scheduler-mcp.js';
import { ScheduledTask } from './types.js';
import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL } from './config.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

export interface SchedulerDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');

  // Create the scheduler MCP with task's group context
  const schedulerMcp = createSchedulerMcp({
    groupFolder: task.group_folder,
    chatJid: task.chat_jid,
    isMain: false, // Scheduled tasks run in their group's context, not as main
    sendMessage: deps.sendMessage
  });

  let result: string | null = null;
  let error: string | null = null;

  try {
    for await (const message of query({
      prompt: task.prompt,
      options: {
        cwd: groupDir,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__nanoclaw__*', 'mcp__gmail__*'],
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
        mcpServers: {
          nanoclaw: schedulerMcp,
          gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] }
        }
      }
    })) {
      if ('result' in message && message.result) {
        result = message.result as string;
      }
    }

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed successfully');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  // Log the run
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error
  });

  // Calculate next run
  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value);
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks don't have a next run

  // Update task
  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        await runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
