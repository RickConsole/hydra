/**
 * NanoClaw - Unified Node.js Implementation
 *
 * Single process that handles:
 * - WhatsApp connection (baileys)
 * - Message routing
 * - Claude Agent SDK queries
 * - Response sending
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  WASocket,
  proto
} from '@whiskeysockets/baileys';
import { query } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// === CONFIGURATION ===

const CONFIG = {
  assistantName: process.env.ASSISTANT_NAME || 'Andy',
  pollInterval: 2000, // ms
  storeDir: './store',
  groupsDir: './groups',
  dataDir: './data',
};

const TRIGGER_PATTERN = new RegExp(`^@${CONFIG.assistantName}\\b`, 'i');
const CLEAR_COMMAND = '/clear';

// === TYPES ===

interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
}

interface Session {
  [folder: string]: string; // folder -> session_id
}

// === LOGGING ===

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

// === DATABASE ===

function initDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
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

  return db;
}

// === FILE HELPERS ===

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

// === STATE ===

let db: Database.Database;
let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

function loadState(): void {
  const statePath = path.join(CONFIG.dataDir, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';

  sessions = loadJson(path.join(CONFIG.dataDir, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(CONFIG.dataDir, 'registered_groups.json'), {});

  logger.info({
    groupCount: Object.keys(registeredGroups).length,
    lastTimestamp: lastTimestamp || '(start)'
  }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(CONFIG.dataDir, 'router_state.json'), { last_timestamp: lastTimestamp });
  saveJson(path.join(CONFIG.dataDir, 'sessions.json'), sessions);
}

// === MESSAGE STORAGE ===

function storeMessage(
  msg: proto.IWebMessageInfo,
  chatJid: string,
  isFromMe: boolean
): void {
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
    // Ensure chat exists first
    db.prepare(`
      INSERT OR REPLACE INTO chats (jid, name, last_message_time)
      VALUES (?, ?, ?)
    `).run(chatJid, chatJid, timestamp);

    // Store message
    db.prepare(`
      INSERT OR REPLACE INTO messages (id, chat_jid, sender, content, timestamp, is_from_me)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(msgId, chatJid, sender, content, timestamp, isFromMe ? 1 : 0);

    logger.debug({ chatJid, msgId }, 'Message stored');
  } catch (err) {
    logger.error({ err, msgId }, 'Failed to store message');
  }
}

// === MESSAGE PROCESSING ===

interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  content: string;
  timestamp: string;
}

function getNewMessages(): NewMessage[] {
  const jids = Object.keys(registeredGroups);
  if (jids.length === 0) {
    logger.debug('No registered groups');
    return [];
  }

  const placeholders = jids.map(() => '?').join(',');
  const query = `
    SELECT id, chat_jid, sender, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
    ORDER BY timestamp
  `;

  logger.debug({ lastTimestamp, jids }, 'Querying messages');

  const rows = db.prepare(query).all(lastTimestamp, ...jids) as NewMessage[];

  for (const row of rows) {
    if (row.timestamp > lastTimestamp) {
      lastTimestamp = row.timestamp;
    }
  }

  return rows;
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();

  // Handle /clear command
  if (content.toLowerCase() === CLEAR_COMMAND) {
    if (sessions[group.folder]) {
      // Archive old session
      const archived = loadJson<Record<string, Array<{ session_id: string; cleared_at: string }>>>(
        path.join(CONFIG.dataDir, 'archived_sessions.json'),
        {}
      );
      if (!archived[group.folder]) archived[group.folder] = [];
      archived[group.folder].push({
        session_id: sessions[group.folder],
        cleared_at: new Date().toISOString()
      });
      saveJson(path.join(CONFIG.dataDir, 'archived_sessions.json'), archived);

      delete sessions[group.folder];
      saveJson(path.join(CONFIG.dataDir, 'sessions.json'), sessions);
    }

    logger.info({ group: group.name }, 'Session cleared');
    await sendMessage(msg.chat_jid, `${CONFIG.assistantName}: Conversation cleared. Starting fresh!`);
    return;
  }

  // Check trigger pattern
  if (!TRIGGER_PATTERN.test(content)) return;

  // Strip trigger from message
  const prompt = content.replace(TRIGGER_PATTERN, '').trim();
  if (!prompt) return;

  logger.info({ group: group.name, prompt: prompt.slice(0, 50) }, 'Processing message');

  // Run agent
  const response = await runAgent(group, prompt, msg.chat_jid);

  if (response) {
    await sendMessage(msg.chat_jid, response);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string
): Promise<string | null> {
  const isMain = group.folder === 'main';
  const groupDir = path.join(CONFIG.groupsDir, group.folder);

  // Ensure group directory exists
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Build context
  const context = `[WhatsApp message from group: ${group.name}]
[Reply to chat_jid: ${chatJid}]
[Can write to global memory (../CLAUDE.md): ${isMain}]
[Prefix your responses with "${CONFIG.assistantName}:"]

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
        allowedTools: [
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch'
        ],
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
        mcpServers: {
          gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
          scheduler: { command: 'npx', args: ['-y', 'schedule-task-mcp'] }
        }
      }
    })) {
      // Capture session ID from init message
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
      }

      // Capture final result
      if ('result' in message && message.result) {
        result = message.result as string;
      }
    }
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return `${CONFIG.assistantName}: Sorry, I encountered an error. Please try again.`;
  }

  // Save session
  if (newSessionId) {
    sessions[group.folder] = newSessionId;
    saveJson(path.join(CONFIG.dataDir, 'sessions.json'), sessions);
  }

  if (result) {
    logger.info({ group: group.name, result: result.slice(0, 100) }, 'Agent response');
  }

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

// === WHATSAPP CONNECTION ===

async function connectWhatsApp(): Promise<void> {
  const authDir = path.join(CONFIG.storeDir, 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0']
  });

  // Handle connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Only show QR if running interactively (not as a background daemon)
      if (process.stdout.isTTY) {
        console.log('\nScan this QR code with WhatsApp:\n');
        qrcode.generate(qr, { small: true });
        console.log('\nWaiting for scan...\n');
      } else {
        logger.error('WhatsApp authentication required but running non-interactively.');
        logger.error('Run "npm run dev" manually to scan the QR code, then restart the service.');
        process.exit(1);
      }
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;

      logger.info({ reason, shouldReconnect }, 'Connection closed');

      if (shouldReconnect) {
        logger.info('Reconnecting...');
        connectWhatsApp();
      } else {
        logger.info('Logged out. Delete store/auth folder and restart to re-authenticate.');
        process.exit(0);
      }
    } else if (connection === 'open') {
      console.log('\n✓ Connected to WhatsApp!\n');
      logger.info('WhatsApp connection established');
      startMessageLoop();
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages (store them)
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;

      const chatJid = msg.key.remoteJid;
      if (!chatJid || chatJid === 'status@broadcast') continue;

      storeMessage(msg, chatJid, msg.key.fromMe || false);
    }
  });
}

// === MAIN LOOP ===

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${CONFIG.assistantName})`);

  while (true) {
    try {
      const messages = getNewMessages();

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'Found new messages');
      }

      for (const msg of messages) {
        await processMessage(msg);
      }

      saveState();
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }

    await new Promise(resolve => setTimeout(resolve, CONFIG.pollInterval));
  }
}

// === ENTRY POINT ===

async function main(): Promise<void> {
  // Initialize database
  const dbPath = path.join(CONFIG.storeDir, 'messages.db');
  db = initDatabase(dbPath);
  logger.info('Database initialized');

  // Load state
  loadState();

  // Connect to WhatsApp
  await connectWhatsApp();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    db.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    db.close();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
