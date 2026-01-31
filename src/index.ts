import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  WASocket,
  proto
} from '@whiskeysockets/baileys';
import { query } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import Database from 'better-sqlite3';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  STORE_DIR,
  GROUPS_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
  CLEAR_COMMAND
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let db: Database.Database;
let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

function initDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  database.exec(`
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
  return database;
}

function loadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    logger.warn({ filePath, error: e }, 'Failed to load JSON file');
  }
  return defaultValue;
}

function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean): void {
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

  try {
    db.prepare(`INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`).run(chatJid, chatJid, timestamp);
    db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?)`).run(msgId, chatJid, sender, content, timestamp, isFromMe ? 1 : 0);
    logger.debug({ chatJid, msgId }, 'Message stored');
  } catch (err) {
    logger.error({ err, msgId }, 'Failed to store message');
  }
}

function getNewMessages(): NewMessage[] {
  const jids = Object.keys(registeredGroups);
  if (jids.length === 0) return [];

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT id, chat_jid, sender, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
    ORDER BY timestamp
  `;

  const rows = db.prepare(sql).all(lastTimestamp, ...jids) as NewMessage[];
  for (const row of rows) {
    if (row.timestamp > lastTimestamp) lastTimestamp = row.timestamp;
  }
  return rows;
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();

  if (content.toLowerCase() === CLEAR_COMMAND) {
    if (sessions[group.folder]) {
      const archived = loadJson<Record<string, Array<{ session_id: string; cleared_at: string }>>>(
        path.join(DATA_DIR, 'archived_sessions.json'), {}
      );
      if (!archived[group.folder]) archived[group.folder] = [];
      archived[group.folder].push({ session_id: sessions[group.folder], cleared_at: new Date().toISOString() });
      saveJson(path.join(DATA_DIR, 'archived_sessions.json'), archived);
      delete sessions[group.folder];
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }
    logger.info({ group: group.name }, 'Session cleared');
    await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: Conversation cleared. Starting fresh!`);
    return;
  }

  if (!TRIGGER_PATTERN.test(content)) return;

  const prompt = content.replace(TRIGGER_PATTERN, '').trim();
  if (!prompt) return;

  logger.info({ group: group.name, prompt: prompt.slice(0, 50) }, 'Processing message');
  const response = await runAgent(group, prompt, msg.chat_jid);
  if (response) await sendMessage(msg.chat_jid, response);
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<string | null> {
  const isMain = group.folder === 'main';
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const context = `[WhatsApp message from group: ${group.name}]
[Reply to chat_jid: ${chatJid}]
[Can write to global memory (../CLAUDE.md): ${isMain}]
[Prefix your responses with "${ASSISTANT_NAME}:"]

User message: ${prompt}`;

  const sessionId = sessions[group.folder];
  let newSessionId: string | undefined;
  let result: string | null = null;

  try {
    for await (const message of query({
      prompt: context,
      options: {
        cwd: groupDir,
        resume: sessionId,
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
        mcpServers: {
          gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
          scheduler: { command: 'npx', args: ['-y', 'schedule-task-mcp'] }
        }
      }
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }
      if ('result' in message && message.result) {
        result = message.result as string;
      }
    }
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return `${ASSISTANT_NAME}: Sorry, I encountered an error. Please try again.`;
  }

  if (newSessionId) {
    sessions[group.folder] = newSessionId;
    saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
  }

  if (result) logger.info({ group: group.name, result: result.slice(0, 100) }, 'Agent response');
  return result;
}

async function sendMessage(jid: string, text: string): Promise<void> {
  try {
    await sock.sendMessage(jid, { text });
    logger.info({ jid, text: text.slice(0, 50) }, 'Message sent');
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(STORE_DIR, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0']
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const msg = 'WhatsApp authentication required. Run /setup in Claude Code.';
      logger.error(msg);
      exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
      setTimeout(() => process.exit(1), 1000);
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting...');
        connectWhatsApp();
      } else {
        logger.info('Logged out. Run /setup to re-authenticate.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      logger.info('Connected to WhatsApp');
      startMessageLoop();
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const chatJid = msg.key.remoteJid;
      if (!chatJid || chatJid === 'status@broadcast') continue;
      storeMessage(msg, chatJid, msg.key.fromMe || false);
    }
  });
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const messages = getNewMessages();
      if (messages.length > 0) logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) await processMessage(msg);
      saveState();
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

async function main(): Promise<void> {
  db = initDatabase(path.join(STORE_DIR, 'messages.db'));
  logger.info('Database initialized');
  loadState();
  await connectWhatsApp();

  const shutdown = () => {
    logger.info('Shutting down...');
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
