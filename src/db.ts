import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { proto } from '@whiskeysockets/baileys';
import { NewMessage } from './types.js';
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
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
  `);
}

export function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean): void {
  if (!msg.key) return;

  const content =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
  const sender = msg.key.participant || msg.key.remoteJid || '';
  const msgId = msg.key.id || '';

  db.prepare(`INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`)
    .run(chatJid, chatJid, timestamp);
  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(msgId, chatJid, sender, content, timestamp, isFromMe ? 1 : 0);
}

export function getNewMessages(jids: string[], lastTimestamp: string): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, content, timestamp
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
    SELECT id, chat_jid, sender, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
    ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, sinceTimestamp) as NewMessage[];
}
