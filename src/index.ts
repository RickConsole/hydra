import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  WASocket
} from '@whiskeysockets/baileys';
import { query } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
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
import { initDatabase, storeMessage, getNewMessages, getMessagesSince } from './db.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

let sock: WASocket;
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

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
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
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

  const userMessage = content.replace(TRIGGER_PATTERN, '').trim();
  if (!userMessage) return;

  // Get messages since last agent interaction to catch up the session
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp);

  // Build prompt with conversation history
  let prompt = '';
  for (const m of missedMessages) {
    if (m.id === msg.id) continue; // Skip current message, we'll add it at the end
    const time = new Date(m.timestamp).toLocaleTimeString();
    const sender = m.sender.split('@')[0]; // Extract phone number or name
    prompt += `[${time}] ${sender}: ${m.content}\n`;
  }
  const time = new Date(msg.timestamp).toLocaleTimeString();
  const sender = msg.sender.split('@')[0];
  prompt += `[${time}] ${sender}: ${userMessage}`;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');
  const response = await runAgent(group, prompt);

  // Update last agent timestamp
  lastAgentTimestamp[msg.chat_jid] = msg.timestamp;

  if (response) {
    await sendMessage(msg.chat_jid, `${ASSISTANT_NAME}: ${response}`);
  }
}

async function runAgent(group: RegisteredGroup, prompt: string): Promise<string | null> {
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const sessionId = sessions[group.folder];
  let newSessionId: string | undefined;
  let result: string | null = null;

  try {
    for await (const message of query({
      prompt,
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
    return null;
  }

  if (newSessionId) {
    sessions[group.folder] = newSessionId;
    saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
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
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp);
      lastTimestamp = newTimestamp;

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
  initDatabase();
  logger.info('Database initialized');
  loadState();
  await connectWhatsApp();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
