import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import {
  createTask,
  getTaskById,
  getTasksForGroup,
  getAllTasks,
  updateTask,
  deleteTask,
  getTaskRunLogs
} from './db.js';
import { ScheduledTask } from './types.js';
import { MAIN_GROUP_FOLDER } from './config.js';

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function calculateNextRun(scheduleType: string, scheduleValue: string): string | null {
  const now = new Date();

  switch (scheduleType) {
    case 'cron': {
      const interval = CronExpressionParser.parse(scheduleValue);
      return interval.next().toISOString();
    }
    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      return new Date(now.getTime() + ms).toISOString();
    }
    case 'once': {
      const runAt = new Date(scheduleValue);
      return runAt > now ? runAt.toISOString() : null;
    }
    default:
      return null;
  }
}

function formatTask(task: ScheduledTask): string {
  const lines = [
    `ID: ${task.id}`,
    `Group: ${task.group_folder}`,
    `Prompt: ${task.prompt}`,
    `Schedule: ${task.schedule_type} (${task.schedule_value})`,
    `Status: ${task.status}`,
    `Next run: ${task.next_run || 'N/A'}`,
    `Last run: ${task.last_run || 'Never'}`,
    `Last result: ${task.last_result || 'N/A'}`
  ];
  return lines.join('\n');
}

export interface SchedulerMcpContext {
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export function createSchedulerMcp(ctx: SchedulerMcpContext) {
  const { groupFolder, chatJid, isMain, sendMessage } = ctx;

  return createSdkMcpServer({
    name: 'nanoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'schedule_task',
        'Schedule a recurring or one-time task. The task will run as an agent in the current group context.',
        {
          prompt: z.string().describe('The prompt/instruction for the task when it runs'),
          schedule_type: z.enum(['cron', 'interval', 'once']).describe('Type of schedule: cron (e.g., "0 9 * * 1" for Mondays at 9am), interval (milliseconds), or once (ISO timestamp)'),
          schedule_value: z.string().describe('Schedule value: cron expression, milliseconds for interval, or ISO timestamp for once'),
          target_group: z.string().optional().describe('(Main channel only) Target group folder to run the task in. Defaults to current group.')
        },
        async (args) => {
          const targetGroup = isMain && args.target_group ? args.target_group : groupFolder;
          const targetJid = isMain && args.target_group ? '' : chatJid; // Will need to look up JID for other groups

          // Validate schedule
          const nextRun = calculateNextRun(args.schedule_type, args.schedule_value);
          if (nextRun === null && args.schedule_type !== 'once') {
            return { content: [{ type: 'text', text: 'Error: Invalid schedule. Task would never run.' }] };
          }

          const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
            id: generateTaskId(),
            group_folder: targetGroup,
            chat_jid: targetJid || chatJid,
            prompt: args.prompt,
            schedule_type: args.schedule_type,
            schedule_value: args.schedule_value,
            next_run: nextRun,
            status: 'active',
            created_at: new Date().toISOString()
          };

          createTask(task);

          return {
            content: [{
              type: 'text',
              text: `Task scheduled successfully!\n\n${formatTask(task as ScheduledTask)}`
            }]
          };
        }
      ),

      tool(
        'list_tasks',
        'List scheduled tasks. Shows tasks for the current group, or all tasks if called from the main channel.',
        {},
        async () => {
          const tasks = isMain ? getAllTasks() : getTasksForGroup(groupFolder);

          if (tasks.length === 0) {
            return { content: [{ type: 'text', text: 'No scheduled tasks found.' }] };
          }

          const formatted = tasks.map((t, i) => `--- Task ${i + 1} ---\n${formatTask(t)}`).join('\n\n');
          return { content: [{ type: 'text', text: `Found ${tasks.length} task(s):\n\n${formatted}` }] };
        }
      ),

      tool(
        'get_task',
        'Get details about a specific task including run history.',
        {
          task_id: z.string().describe('The task ID')
        },
        async (args) => {
          const task = getTaskById(args.task_id);
          if (!task) {
            return { content: [{ type: 'text', text: `Task not found: ${args.task_id}` }] };
          }

          // Check permissions
          if (!isMain && task.group_folder !== groupFolder) {
            return { content: [{ type: 'text', text: 'Access denied: Task belongs to another group.' }] };
          }

          const logs = getTaskRunLogs(args.task_id, 5);
          let output = formatTask(task);

          if (logs.length > 0) {
            output += '\n\n--- Recent Runs ---\n';
            output += logs.map(l =>
              `${l.run_at}: ${l.status} (${l.duration_ms}ms)${l.error ? ` - ${l.error}` : ''}`
            ).join('\n');
          }

          return { content: [{ type: 'text', text: output }] };
        }
      ),

      tool(
        'update_task',
        'Update a scheduled task.',
        {
          task_id: z.string().describe('The task ID'),
          prompt: z.string().optional().describe('New prompt for the task'),
          schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
          schedule_value: z.string().optional().describe('New schedule value')
        },
        async (args) => {
          const task = getTaskById(args.task_id);
          if (!task) {
            return { content: [{ type: 'text', text: `Task not found: ${args.task_id}` }] };
          }

          if (!isMain && task.group_folder !== groupFolder) {
            return { content: [{ type: 'text', text: 'Access denied: Task belongs to another group.' }] };
          }

          const updates: Parameters<typeof updateTask>[1] = {};
          if (args.prompt) updates.prompt = args.prompt;
          if (args.schedule_type) updates.schedule_type = args.schedule_type;
          if (args.schedule_value) updates.schedule_value = args.schedule_value;

          // Recalculate next_run if schedule changed
          if (args.schedule_type || args.schedule_value) {
            const schedType = args.schedule_type || task.schedule_type;
            const schedValue = args.schedule_value || task.schedule_value;
            updates.next_run = calculateNextRun(schedType, schedValue);
          }

          updateTask(args.task_id, updates);
          const updated = getTaskById(args.task_id)!;

          return { content: [{ type: 'text', text: `Task updated!\n\n${formatTask(updated)}` }] };
        }
      ),

      tool(
        'pause_task',
        'Pause a scheduled task.',
        {
          task_id: z.string().describe('The task ID')
        },
        async (args) => {
          const task = getTaskById(args.task_id);
          if (!task) {
            return { content: [{ type: 'text', text: `Task not found: ${args.task_id}` }] };
          }

          if (!isMain && task.group_folder !== groupFolder) {
            return { content: [{ type: 'text', text: 'Access denied: Task belongs to another group.' }] };
          }

          updateTask(args.task_id, { status: 'paused' });
          return { content: [{ type: 'text', text: `Task ${args.task_id} paused.` }] };
        }
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        {
          task_id: z.string().describe('The task ID')
        },
        async (args) => {
          const task = getTaskById(args.task_id);
          if (!task) {
            return { content: [{ type: 'text', text: `Task not found: ${args.task_id}` }] };
          }

          if (!isMain && task.group_folder !== groupFolder) {
            return { content: [{ type: 'text', text: 'Access denied: Task belongs to another group.' }] };
          }

          // Recalculate next_run when resuming
          const nextRun = calculateNextRun(task.schedule_type, task.schedule_value);
          updateTask(args.task_id, { status: 'active', next_run: nextRun });

          return { content: [{ type: 'text', text: `Task ${args.task_id} resumed. Next run: ${nextRun}` }] };
        }
      ),

      tool(
        'cancel_task',
        'Cancel and delete a scheduled task.',
        {
          task_id: z.string().describe('The task ID')
        },
        async (args) => {
          const task = getTaskById(args.task_id);
          if (!task) {
            return { content: [{ type: 'text', text: `Task not found: ${args.task_id}` }] };
          }

          if (!isMain && task.group_folder !== groupFolder) {
            return { content: [{ type: 'text', text: 'Access denied: Task belongs to another group.' }] };
          }

          deleteTask(args.task_id);
          return { content: [{ type: 'text', text: `Task ${args.task_id} cancelled and deleted.` }] };
        }
      ),

      tool(
        'send_message',
        'Send a message to the WhatsApp group. Use this to notify the group about task results or updates.',
        {
          text: z.string().describe('The message text to send'),
          target_jid: z.string().optional().describe('(Main channel only) Target group JID. Defaults to current group.')
        },
        async (args) => {
          const targetJid = isMain && args.target_jid ? args.target_jid : chatJid;

          try {
            await sendMessage(targetJid, args.text);
            return { content: [{ type: 'text', text: 'Message sent successfully.' }] };
          } catch (error) {
            return { content: [{ type: 'text', text: `Failed to send message: ${error}` }] };
          }
        }
      )
    ]
  });
}

export { calculateNextRun };
