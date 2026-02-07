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
  loadBotRegistry,
  MAIN_GROUP_FOLDER,
  parseTelegramJid,
  parseVoiceJid,
  TIMEZONE,
  VOICE_ENABLED,
  VOICE_GROUP,
} from './config.js';
import {
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
    logger.debug({ jid, err }, 'Failed to set typing indicator');
  }
}

async function sendTelegramMessage(botKey: string, chatId: string, text: string): Promise<void> {
  const bot = bots.get(botKey);
  if (!bot) {
    logger.error({ botKey, chatId }, 'Bot not found for sending message');
    return;
  }
  try {
    await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    logger.info({ botKey, chatId, length: text.length }, 'Telegram message sent');
  } catch (error) {
    logger.error({ error, botKey, chatId }, 'Failed to send Telegram message');
    throw error;
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
  registeredGroups = loadJson(
    path.join(DATA_DIR, 'registered_groups.json'),
    {},
  );
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
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
  prompt: string,
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

  logger.warn({ jid }, 'Unknown JID format, cannot send');
}

function setupBot(botKey: string, botConfig: { token: string; name: string }): void {
  const bot = new Telegraf(botConfig.token, {
    handlerTimeout: 180_000, // 3 minutes (default is 90s)
  });
  const triggerPattern = getTriggerPattern(botConfig.name);

  bot.on('message', async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;

    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const telegramJid = buildTelegramJid(botKey, chatId);

    logger.info(
      { botKey, chatId, isGroup, senderName },
      `Telegram message: ${ctx.message.text}`,
    );

    try {
      if (!registeredGroups[telegramJid]) {
        logger.debug({ botKey, chatId }, 'Message from unregistered Telegram chat');
        return;
      }

      storeChatMetadata(telegramJid, timestamp);

      const group = registeredGroups[telegramJid];
      const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
      const content = ctx.message.text.trim();

      // Handle /new command - reset session for this group
      if (content === '/new' || content.toLowerCase() === '/new') {
        delete sessions[group.folder];
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
        logger.info({ group: group.name }, 'Session reset via /new command');
        await sendMessage(telegramJid, '🔄 Context cleared. Starting fresh!');
        return;
      }

      // DMs always respond; group chats require @BotName trigger
      if (isGroup && !isMainGroup && !triggerPattern.test(content)) return;
      // For DMs (non-group), always respond regardless of trigger

      const escapeXml = (s: string) =>
        s
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

      const prompt = `<messages>\n<message sender="${escapeXml(senderName)}" time="${timestamp}">${escapeXml(ctx.message.text)}</message>\n</messages>`;

      logger.info({ botKey, group: group.name, senderName }, 'Processing Telegram message');

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
        await bot.telegram.sendMessage(chatId, 'Sorry, something went wrong.');
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
            .filter((f) => f.endsWith('.json'));
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
            .filter((f) => f.endsWith('.json'));
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
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');

  // Load bot registry
  botRegistry = loadBotRegistry();
  const botKeys = Object.keys(botRegistry);
  logger.info({ bots: botKeys }, 'Bot registry loaded');

  // Load state before migration
  loadState();

  // Migrate old-format JIDs using the first bot key as default
  const defaultBotKey = botKeys[0];
  migrateTelegramJids(defaultBotKey);
  migrateDataFileJids(defaultBotKey);

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

  // Start background services
  const stopIpcWatcher = startIpcWatcher();
  const stopScheduler = startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    if (VOICE_ENABLED) {
      import('./voice.js').then(({ stopVoiceServer }) => stopVoiceServer()).catch(() => {});
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
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
