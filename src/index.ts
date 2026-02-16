import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { Telegraf } from 'telegraf';

import {
  buildTelegramJid,
  buildVoiceJid,
  DATA_DIR,
  getTriggerPattern,
  IPC_POLL_INTERVAL,
  isUsingUnifiedConfig,
  loadBotRegistry,
  loadRegisteredGroups,
  MAIN_GROUP_FOLDER,
  parseSmsJid,
  parseTelegramJid,
  parseVoiceJid,
  SMS_ENABLED,
  SMS_GROUP,
  TIMEZONE,
  VOICE_ENABLED,
  VOICE_GROUP,
} from './config.js';
import {
  ContentBlock,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  initDatabase,
  migrateTelegramJids,
  storeChatMetadata,
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { BotRegistry, RegisteredGroup, Session } from './types.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import { createApiServer, stopApiServer, createApiContext, initContext } from './api/index.js';
import type http from 'http';

// Multi-bot state
let botRegistry: BotRegistry = {};
const bots = new Map<string, Telegraf>();

let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let ipcWatcherRunning = false;

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (!isTyping) return;
  const parsed = parseTelegramJid(jid);
  if (!parsed) return;
  const bot = bots.get(parsed.botKey);
  if (!bot) return;
  try {
    await bot.telegram.sendChatAction(parsed.chatId, 'typing');
  } catch (err) {
    // Elevated to warn level for visibility - typing failures can indicate rate limiting
    logger.warn({ jid, err }, 'Failed to set typing indicator');
  }
}

// Telegram message limit is 4096 characters
const TELEGRAM_MAX_LENGTH = 4096;

// Split long messages into chunks, trying to break at natural points
function splitMessage(text: string, maxLength: number = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good break point (double newline, single newline, space)
    let breakPoint = -1;
    const searchRange = remaining.slice(0, maxLength);

    // Prefer breaking at paragraph boundaries
    const lastDoubleNewline = searchRange.lastIndexOf('\n\n');
    if (lastDoubleNewline > maxLength * 0.5) {
      breakPoint = lastDoubleNewline + 2;
    } else {
      // Try single newline
      const lastNewline = searchRange.lastIndexOf('\n');
      if (lastNewline > maxLength * 0.5) {
        breakPoint = lastNewline + 1;
      } else {
        // Try space
        const lastSpace = searchRange.lastIndexOf(' ');
        if (lastSpace > maxLength * 0.5) {
          breakPoint = lastSpace + 1;
        } else {
          // Hard break at max length
          breakPoint = maxLength;
        }
      }
    }

    chunks.push(remaining.slice(0, breakPoint).trimEnd());
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

// Supported image MIME types for the Claude API
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function downloadFileAsBase64(
  bot: Telegraf,
  fileId: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    if (!response.ok) {
      logger.error({ fileId, status: response.status }, 'Failed to download Telegram file');
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    return { data: buffer.toString('base64'), mimeType };
  } catch (err) {
    logger.error({ fileId, err }, 'Error downloading Telegram file');
    return null;
  }
}

// Helper to check if error is a rate limit (429) error
function isRateLimitError(error: unknown): { retryAfter: number } | null {
  if (!(error instanceof Error) || !('response' in error)) return null;
  const response = error.response as { error_code?: number; parameters?: { retry_after?: number } };
  if (response?.error_code === 429) {
    return { retryAfter: response.parameters?.retry_after || 1 };
  }
  return null;
}

// Helper to send a single message with retry logic for rate limits
async function sendWithRetry(
  bot: Telegraf,
  chatId: string,
  text: string,
  parseMode: 'Markdown' | undefined,
  maxRetries: number = 3,
): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await bot.telegram.sendMessage(chatId, text, parseMode ? { parse_mode: parseMode } : {});
      return;
    } catch (error) {
      const rateLimit = isRateLimitError(error);
      if (rateLimit && attempt < maxRetries) {
        // Exponential backoff: use Telegram's retry_after or 2^attempt seconds
        const waitTime = Math.max(rateLimit.retryAfter, Math.pow(2, attempt)) * 1000;
        logger.warn({ chatId, attempt, waitTime, retryAfter: rateLimit.retryAfter }, 'Rate limited, waiting before retry');
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      throw error;
    }
  }
}

async function sendTelegramMessage(botKey: string, chatId: string, text: string): Promise<void> {
  const bot = bots.get(botKey);
  if (!bot) {
    logger.error({ botKey, chatId }, 'Bot not found for sending message');
    return;
  }

  // Split long messages into chunks
  const chunks = splitMessage(text);
  const isMultiPart = chunks.length > 1;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = isMultiPart ? `[${i + 1}/${chunks.length}]\n${chunks[i]}` : chunks[i];

    try {
      await sendWithRetry(bot, chatId, chunk, 'Markdown');
      logger.info({ botKey, chatId, length: chunk.length, part: i + 1, total: chunks.length }, 'Telegram message sent');
    } catch (error) {
      // If Markdown parsing fails, retry without formatting
      const isMarkdownError = error instanceof Error &&
        'response' in error &&
        typeof error.response === 'object' &&
        error.response !== null &&
        'description' in error.response &&
        typeof error.response.description === 'string' &&
        error.response.description.includes("can't parse entities");

      if (isMarkdownError) {
        logger.warn({ botKey, chatId, part: i + 1 }, 'Markdown parse failed, retrying as plain text');
        try {
          await sendWithRetry(bot, chatId, chunk, undefined);
          logger.info({ botKey, chatId, length: chunk.length, part: i + 1, total: chunks.length }, 'Telegram message sent (plain text fallback)');
        } catch (retryError) {
          logger.error({ error: retryError, botKey, chatId, part: i + 1 }, 'Failed to send plain text fallback');
          throw retryError;
        }
      } else {
        logger.error({ error, botKey, chatId, part: i + 1 }, 'Failed to send Telegram message');
        throw error;
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});

  // Load registered groups from hydra.yaml if available, else from JSON
  registeredGroups = loadRegisteredGroups();

  // Fall back to JSON file if unified config returned empty (backward compat)
  if (Object.keys(registeredGroups).length === 0) {
    registeredGroups = loadJson(
      path.join(DATA_DIR, 'registered_groups.json'),
      {},
    );
  }

  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      source: isUsingUnifiedConfig() ? 'hydra.yaml' : 'legacy',
    },
    'State loaded',
  );
}

/**
 * Migrate old-format JIDs in JSON data files.
 * Old format: telegram:CHATID → New format: telegram:BOTKEY:CHATID
 */
function migrateDataFileJids(defaultBotKey: string): void {
  let migrated = 0;

  // Migrate registered_groups.json keys
  const newGroups: Record<string, RegisteredGroup> = {};
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (jid.startsWith('telegram:') && jid.split(':').length === 2) {
      const chatId = jid.split(':')[1];
      const newJid = buildTelegramJid(defaultBotKey, chatId);
      newGroups[newJid] = group;
      migrated++;
    } else {
      newGroups[jid] = group;
    }
  }
  if (migrated > 0) {
    registeredGroups = newGroups;
    saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);
    logger.info({ migrated }, 'Migrated registered_groups.json JIDs');
  }

  // Migrate router_state.json last_agent_timestamp keys
  let tsMigrated = 0;
  const newTimestamps: Record<string, string> = {};
  for (const [jid, ts] of Object.entries(lastAgentTimestamp)) {
    if (jid.startsWith('telegram:') && jid.split(':').length === 2) {
      const chatId = jid.split(':')[1];
      const newJid = buildTelegramJid(defaultBotKey, chatId);
      newTimestamps[newJid] = ts;
      tsMigrated++;
    } else {
      newTimestamps[jid] = ts;
    }
  }
  if (tsMigrated > 0) {
    lastAgentTimestamp = newTimestamps;
    saveState();
    logger.info({ migrated: tsMigrated }, 'Migrated router_state.json JIDs');
  }
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string | ContentBlock[],
  chatJid: string,
): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Write groups snapshot
  writeGroupsSnapshot(
    group.folder,
    isMain,
    [],
    new Set(Object.keys(registeredGroups)),
  );

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(jid: string, text: string): Promise<void> {
  const parsed = parseTelegramJid(jid);
  if (parsed) {
    await sendTelegramMessage(parsed.botKey, parsed.chatId, text);
    return;
  }

  const voiceParsed = parseVoiceJid(jid);
  if (voiceParsed) {
    // Voice responses are handled via TTS in the voice server poll loop;
    // IPC messages to voice JIDs get queued as TTS responses
    const { queueVoiceResponse } = await import('./voice.js');
    await queueVoiceResponse(voiceParsed.callSid, text);
    return;
  }

  const smsParsed = parseSmsJid(jid);
  if (smsParsed) {
    const { sendSms } = await import('./sms.js');
    await sendSms(smsParsed.phoneNumber, text);
    return;
  }

  logger.warn({ jid }, 'Unknown JID format, cannot send');
}

function setupBot(botKey: string, botConfig: { token: string; name: string }): void {
  const bot = new Telegraf(botConfig.token, {
    handlerTimeout: 360_000, // 6 minutes - longer than container timeout (5 min) to ensure responses come through
  });
  const triggerPattern = getTriggerPattern(botConfig.name);

  bot.on('message', async (ctx) => {
    if (!ctx.message) return;
    const hasText = 'text' in ctx.message;
    const hasPhoto = 'photo' in ctx.message;
    const hasDocument = 'document' in ctx.message;
    if (!hasText && !hasPhoto && !hasDocument) return;

    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const telegramJid = buildTelegramJid(botKey, chatId);

    // Extract text: from text messages or captions on media
    const textContent = hasText
      ? (ctx.message as { text: string }).text
      : ('caption' in ctx.message ? (ctx.message as { caption?: string }).caption || '' : '');

    logger.info(
      { botKey, chatId, isGroup, senderName, hasPhoto, hasDocument },
      `Telegram message: ${textContent.slice(0, 200) || '[media]'}`,
    );

    try {
      if (!registeredGroups[telegramJid]) {
        logger.debug({ botKey, chatId }, 'Message from unregistered Telegram chat');
        return;
      }

      storeChatMetadata(telegramJid, timestamp);

      const group = registeredGroups[telegramJid];
      const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
      const content = textContent.trim();

      // Handle /new command - reset session for this group
      if (content === '/new' || content.toLowerCase() === '/new') {
        delete sessions[group.folder];
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
        logger.info({ group: group.name }, 'Session reset via /new command');
        await sendMessage(telegramJid, '🔄 Context cleared. Starting fresh!');
        return;
      }

      // DMs always respond; group chats require @BotName trigger (in text or caption)
      if (isGroup && !isMainGroup) {
        if (!content || !triggerPattern.test(content)) return;
      }

      const escapeXml = (s: string) =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

      // Build prompt: multimodal for photos/documents, string for text-only
      let prompt: string | ContentBlock[];

      if (hasPhoto || hasDocument) {
        // Multimodal path
        const blocks: ContentBlock[] = [];

        // Text block with sender/timestamp wrapper
        const textWrapper = `<messages>\n<message sender="${escapeXml(senderName)}" time="${timestamp}">${content ? escapeXml(content) : '[attached media]'}</message>\n</messages>`;
        blocks.push({ type: 'text', text: textWrapper });

        if (hasPhoto) {
          const photos = (ctx.message as { photo: Array<{ file_id: string }> }).photo;
          const bestPhoto = photos[photos.length - 1]; // highest resolution
          const downloaded = await downloadFileAsBase64(bot, bestPhoto.file_id);
          if (downloaded) {
            // Telegram may return generic content-type; default to JPEG for photos
            const mimeType = SUPPORTED_IMAGE_TYPES.has(downloaded.mimeType)
              ? downloaded.mimeType
              : 'image/jpeg';
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: downloaded.data },
            });
            logger.info({ botKey, chatId, mimeType }, 'Photo downloaded and encoded');
          } else {
            logger.warn({ botKey, chatId }, 'Photo download failed, proceeding with text only');
          }
        }

        if (hasDocument) {
          const doc = (ctx.message as { document: { file_id: string; mime_type?: string; file_name?: string } }).document;
          const docMime = doc.mime_type || 'application/octet-stream';

          if (docMime === 'application/pdf') {
            const downloaded = await downloadFileAsBase64(bot, doc.file_id);
            if (downloaded) {
              blocks.push({
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: downloaded.data },
                ...(doc.file_name ? { title: doc.file_name } : {}),
              });
              logger.info({ botKey, chatId, fileName: doc.file_name }, 'PDF downloaded and encoded');
            } else {
              logger.warn({ botKey, chatId }, 'PDF download failed, proceeding with text only');
            }
          } else if (SUPPORTED_IMAGE_TYPES.has(docMime)) {
            // Image sent as document (uncompressed)
            const downloaded = await downloadFileAsBase64(bot, doc.file_id);
            if (downloaded) {
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: docMime, data: downloaded.data },
              });
              logger.info({ botKey, chatId, mimeType: docMime }, 'Image document downloaded and encoded');
            }
          } else {
            logger.info({ botKey, chatId, mimeType: docMime }, 'Unsupported document type, processing caption only');
          }
        }

        // Use multimodal only if we successfully got media blocks; otherwise fall back to text
        prompt = blocks.length > 1 ? blocks : `<messages>\n<message sender="${escapeXml(senderName)}" time="${timestamp}">${content ? escapeXml(content) : '[unsupported media]'}</message>\n</messages>`;
      } else {
        // Text-only path (existing behavior)
        prompt = `<messages>\n<message sender="${escapeXml(senderName)}" time="${timestamp}">${escapeXml(textContent)}</message>\n</messages>`;
      }

      logger.info({ botKey, group: group.name, senderName, multimodal: Array.isArray(prompt) }, 'Processing Telegram message');

      // Keep typing indicator alive by refreshing every 4 seconds
      await setTyping(telegramJid, true);
      const typingInterval = setInterval(() => {
        setTyping(telegramJid, true);
      }, 4000);

      let response: string | null;
      try {
        response = await runAgent(group, prompt, telegramJid);
      } finally {
        clearInterval(typingInterval);
      }

      if (response) {
        lastAgentTimestamp[telegramJid] = timestamp;
        await sendMessage(telegramJid, response);
      }
    } catch (error) {
      logger.error({ error, botKey, chatId }, 'Error processing Telegram message');
      try {
        // Include error details in the message for easier debugging
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorDetails = error instanceof Error && 'response' in error
          ? JSON.stringify((error as { response?: unknown }).response, null, 2)
          : '';
        const debugInfo = errorDetails
          ? `Sorry, something went wrong.\n\n\`\`\`\n${errorMessage}\n${errorDetails}\n\`\`\``
          : `Sorry, something went wrong.\n\n\`\`\`\n${errorMessage}\n\`\`\``;
        await bot.telegram.sendMessage(chatId, debugInfo);
      } catch {
        // ignore send failure during error handling
      }
    }
  });

  bots.set(botKey, bot);
  logger.info({ botKey, name: botConfig.name }, 'Bot configured');
}

function startIpcWatcher(): () => void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return () => {};
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  let stopRequested = false;
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const processIpcFiles = async () => {
    if (stopRequested) return;
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      if (!stopRequested) timerId = setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'))
            .sort(); // Sort chronologically (filenames start with timestamp)
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Show typing indicator before sending IPC message
                  await setTyping(data.chatJid, true);
                  // Telegram bots send as themselves, no prefix needed
                  const ipcMsg = data.chatJid.startsWith('telegram:')
                    ? data.text
                    : data.text;
                  await sendMessage(data.chatJid, ipcMsg);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'))
            .sort(); // Sort chronologically (filenames start with timestamp)
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    if (!stopRequested) timerId = setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');

  return () => {
    stopRequested = true;
    if (timerId) clearTimeout(timerId);
  };
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  const {
    createTask,
    updateTask,
    deleteTask,
    getTaskById: getTask,
  } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.groupFolder
      ) {
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0];

        if (!targetJid) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      logger.info({ sourceGroup }, 'refresh_groups is not supported with Telegram');
      break;

    case 'register_group':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.info('Docker runtime detected and running');
    return;
  } catch {
    // Docker not available or not running
  }

  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
    return;
  } catch {
    // Apple Container not running, try to start it
  }

  try {
    logger.info('Starting Apple Container system...');
    execSync('container system start', { stdio: 'pipe', timeout: 30000 });
    logger.info('Apple Container system started');
    return;
  } catch {
    // Apple Container not available
  }

  console.error(
    '\n╔════════════════════════════════════════════════════════════════╗',
  );
  console.error(
    '║  FATAL: No container runtime available                         ║',
  );
  console.error(
    '║                                                                ║',
  );
  console.error(
    '║  Install one of:                                              ║',
  );
  console.error(
    '║  - Docker: https://docs.docker.com/get-docker/                ║',
  );
  console.error(
    '║  - Apple Container: https://github.com/apple/container        ║',
  );
  console.error(
    '╚════════════════════════════════════════════════════════════════╝\n',
  );
  throw new Error('No container runtime available');
}

async function main(): Promise<void> {
  // Log config source
  if (isUsingUnifiedConfig()) {
    logger.info('Starting Hydra with unified config (hydra.yaml)');
  } else {
    logger.info('Starting Hydra with legacy config (data/*.json + .env)');
  }

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  // Load bot registry (from hydra.yaml or legacy sources)
  botRegistry = loadBotRegistry();
  const botKeys = Object.keys(botRegistry);
  logger.info({ bots: botKeys, source: isUsingUnifiedConfig() ? 'hydra.yaml' : 'legacy' }, 'Bot registry loaded');

  // Load state before migration
  loadState();

  // Migrate old-format JIDs using the first bot key as default (skip if no bots)
  const defaultBotKey = botKeys[0];
  if (defaultBotKey) {
    migrateTelegramJids(defaultBotKey);
    migrateDataFileJids(defaultBotKey);
  }

  // Setup all bots
  for (const [botKey, botConfig] of Object.entries(botRegistry)) {
    setupBot(botKey, botConfig);
  }

  // Launch all bots
  for (const [botKey, bot] of bots) {
    bot.launch();
    logger.info({ botKey }, 'Telegram bot launched');

    // Register bot commands
    bot.telegram.setMyCommands([
      { command: 'new', description: 'Start a fresh conversation' },
    ]).catch((err) => logger.warn({ botKey, err }, 'Failed to register bot commands'));
  }

  // Start voice server if enabled
  if (VOICE_ENABLED) {
    const { startVoiceServer } = await import('./voice.js');
    const voiceGroup = Object.values(registeredGroups).find((g) => g.folder === VOICE_GROUP);
    if (voiceGroup) {
      const voiceRunAgent = async (prompt: string, chatJid: string) => {
        return runAgent(voiceGroup, prompt, chatJid);
      };
      await startVoiceServer(voiceRunAgent, sendMessage);
      logger.info({ group: VOICE_GROUP }, 'Voice calling enabled');
    } else {
      logger.warn({ group: VOICE_GROUP }, 'Voice group not found in registered groups, voice disabled');
    }
  }

  // Enable SMS handling if configured (uses same server as voice)
  if (SMS_ENABLED) {
    const smsGroup = Object.values(registeredGroups).find((g) => g.folder === SMS_GROUP);
    if (smsGroup) {
      const smsRunAgent = async (prompt: string, chatJid: string) => {
        return runAgent(smsGroup, prompt, chatJid);
      };
      // SMS shares the voice server - just set the callback
      if (VOICE_ENABLED) {
        const { setSmsAgentCallback } = await import('./voice.js');
        setSmsAgentCallback(smsRunAgent);
        logger.info({ group: SMS_GROUP, webhookUrl: 'https://' + process.env.NGROK_DOMAIN + '/sms/incoming' }, 'SMS enabled (via voice server)');
      } else {
        logger.warn('SMS requires VOICE_ENABLED=true (shares the same webhook server)');
      }
    } else {
      logger.warn({ group: SMS_GROUP }, 'SMS group not found in registered groups, SMS disabled');
    }
  }

  // Start background services
  const stopIpcWatcher = startIpcWatcher();
  const stopScheduler = startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  });

  // Start API server for Hydra Console
  const apiPort = parseInt(process.env.HYDRA_API_PORT || '3340', 10);

  // Initialize API context with orchestrator dependencies
  initContext({
    getRegisteredGroups: () => registeredGroups,
    getSessions: () => sessions,
    setSessions: (newSessions) => {
      sessions = newSessions;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    },
  });

  const apiContext = createApiContext();
  let apiServer: http.Server | null = null;
  if (process.env.HYDRA_API_ENABLED !== 'false') {
    apiServer = createApiServer(apiContext, apiPort);
  }

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    if (VOICE_ENABLED) {
      import('./voice.js').then(({ stopVoiceServer }) => stopVoiceServer()).catch(() => {});
    }
    // SMS is handled by voice server, no separate shutdown needed
    if (apiServer) {
      stopApiServer(apiServer).catch(() => {});
    }
    stopIpcWatcher();
    stopScheduler();
    for (const [botKey, bot] of bots) {
      bot.stop(signal);
      logger.debug({ botKey }, 'Bot stopped');
    }
    setTimeout(() => process.exit(1), 5000).unref();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start Hydra');
  process.exit(1);
});
