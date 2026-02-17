/**
 * Standalone stdio MCP server for Claude Code CLI
 * Reads context from env vars, exposes IPC tools via stdin/stdout JSON-RPC
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

const agentFolder = process.env.HYDRA_AGENT_FOLDER || 'unknown';
const chatJid = process.env.HYDRA_CHAT_JID || 'cli:local:unknown';
const isMain = process.env.HYDRA_IS_MAIN === 'true';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

const server = new McpServer({
  name: 'hydra',
  version: '1.0.0',
});

server.tool(
  'send_message',
  'Send a message to the current chat. Use this to proactively share information or updates.',
  { text: z.string().describe('The message text to send') },
  async (args) => {
    const data = {
      type: 'message',
      chatJid,
      text: args.text,
      agentFolder,
      timestamp: new Date().toISOString(),
    };
    const filename = writeIpcFile(MESSAGES_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Message queued for delivery (${filename})` }],
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task.

CONTEXT MODE:
• "group": Task runs with chat history and memory context.
• "isolated": Task runs in a fresh session. Include all context in the prompt.

SCHEDULE VALUE FORMAT (all times LOCAL):
• cron: e.g., "0 9 * * *" for daily at 9am
• interval: milliseconds, e.g., "300000" for 5 minutes
• once: local timestamp, e.g., "2026-02-01T15:30:00" (no Z suffix)`,
  {
    prompt: z.string().describe('What the agent should do when the task runs'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('group'),
    target_agent: z.string().optional().describe('Target agent folder (main only)'),
  },
  async (args) => {
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const targetAgent = isMain && args.target_agent ? args.target_agent : agentFolder;
    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      agentFolder: targetAgent,
      chatJid,
      createdBy: agentFolder,
      timestamp: new Date().toISOString(),
    };
    const filename = writeIpcFile(TASKS_DIR, data);
    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. Main sees all, others see only their agent's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }
      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { agentFolder: string }) => t.agentFolder === agentFolder);
      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }
      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'pause_task',
      taskId: args.task_id,
      agentFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'resume_task',
      taskId: args.task_id,
      agentFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'cancel_task',
      taskId: args.task_id,
      agentFolder,
      isMain,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
