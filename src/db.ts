import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { proto } from '@whiskeysockets/baileys';
import { NewMessage, ScheduledTask, TaskRunLog } from './types.js';
import { STORE_DIR } from './config.js';

let db: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);

  // Add sender_name column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
  } catch { /* column already exists */ }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  } catch { /* column already exists */ }
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(chatJid: string, timestamp: string): void {
  db.prepare(`INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`)
    .run(chatJid, chatJid, timestamp);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean, pushName?: string): void {
  if (!msg.key) return;

  const content =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
  const sender = msg.key.participant || msg.key.remoteJid || '';
  const senderName = pushName || sender.split('@')[0];
  const msgId = msg.key.id || '';

  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(msgId, chatJid, sender, senderName, content, timestamp, isFromMe ? 1 : 0);
}

export function getNewMessages(jids: string[], lastTimestamp: string): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
    ORDER BY timestamp
  `;

  const rows = db.prepare(sql).all(lastTimestamp, ...jids) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(chatJid: string, sinceTimestamp: string): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
    ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, sinceTimestamp) as NewMessage[];
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC').all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.schedule_type !== undefined) { fields.push('schedule_type = ?'); values.push(updates.schedule_type); }
  if (updates.schedule_value !== undefined) { fields.push('schedule_value = ?'); values.push(updates.schedule_value); }
  if (updates.next_run !== undefined) { fields.push('next_run = ?'); values.push(updates.next_run); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `).all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  return db.prepare(`
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `).all(taskId, limit) as TaskRunLog[];
}
