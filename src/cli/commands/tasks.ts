/**
 * hydra tasks — List scheduled tasks from SQLite DB
 *
 * Works even when the orchestrator is down (direct DB access).
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { dim, table, yellow, green, red } from '../format.js';

const STORE_DIR = path.resolve(process.cwd(), 'store');
const DB_PATH = path.join(STORE_DIR, 'messages.db');

interface TaskRow {
  id: string;
  agent_folder: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  last_run: string | null;
  last_run_status: string | null;
  status: string;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active': return green(status);
    case 'paused': return yellow(status);
    case 'completed': return dim(status);
    case 'failed': return red(status);
    default: return status;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

export async function run(_args: string[]): Promise<void> {
  if (!fs.existsSync(DB_PATH)) {
    console.log(dim('No database found. Start the orchestrator first.'));
    return;
  }

  const db = new Database(DB_PATH, { readonly: true });

  let tasks: TaskRow[];
  try {
    // Use SELECT * to handle DBs with different column sets (migrations run by orchestrator)
    tasks = db.prepare(
      'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
    ).all() as TaskRow[];
  } catch (err) {
    // Table may not exist if orchestrator has never run
    if (String(err).includes('no such table')) {
      console.log(dim('No scheduled tasks table. Start the orchestrator first.'));
      return;
    }
    throw err;
  } finally {
    db.close();
  }

  if (tasks.length === 0) {
    console.log(dim('No scheduled tasks'));
    return;
  }

  const rows = tasks.map(t => [
    t.id.slice(0, 8),
    t.agent_folder,
    truncate(t.prompt.replace(/\n/g, ' '), 40),
    `${t.schedule_type}:${t.schedule_value}`,
    statusColor(t.status),
    t.next_run ? new Date(t.next_run).toLocaleString() : dim('—'),
  ]);

  table(['ID', 'AGENT', 'PROMPT', 'SCHEDULE', 'STATUS', 'NEXT RUN'], rows);
}
