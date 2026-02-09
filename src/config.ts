import fs from 'fs';
import path from 'path';

import { BotRegistry } from './types.js';

export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '300000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getTriggerPattern(botName: string): RegExp {
  return new RegExp(`^@${escapeRegex(botName)}\\b`, 'i');
}

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Load bot registry from data/bots.json, falling back to env vars for backward compat.
 * If bots.json doesn't exist but TELEGRAM_BOT_TOKEN is set, creates bots.json automatically.
 */
export function loadBotRegistry(): BotRegistry {
  const botsPath = path.join(DATA_DIR, 'bots.json');

  if (fs.existsSync(botsPath)) {
    return JSON.parse(fs.readFileSync(botsPath, 'utf-8')) as BotRegistry;
  }

  // Backward compat: create from env vars
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      'No bot configuration found. Create data/bots.json or set TELEGRAM_BOT_TOKEN env var.',
    );
  }

  const name = process.env.ASSISTANT_NAME || 'Andy';
  const key = name.toLowerCase();
  const registry: BotRegistry = {
    [key]: { token, name },
  };

  // Persist so future starts use bots.json
  fs.mkdirSync(path.dirname(botsPath), { recursive: true });
  fs.writeFileSync(botsPath, JSON.stringify(registry, null, 2));

  return registry;
}

/**
 * Parse a telegram JID into its components.
 * New format: telegram:BOTKEY:CHATID
 * Old format: telegram:CHATID (returns null botKey)
 */
export function parseTelegramJid(jid: string): { botKey: string; chatId: string } | null {
  if (!jid.startsWith('telegram:')) return null;
  const parts = jid.split(':');
  if (parts.length === 3) {
    return { botKey: parts[1], chatId: parts[2] };
  }
  // Old format — shouldn't happen after migration but handle gracefully
  if (parts.length === 2) {
    return { botKey: '', chatId: parts[1] };
  }
  return null;
}

export function buildTelegramJid(botKey: string, chatId: string): string {
  return `telegram:${botKey}:${chatId}`;
}

// Voice calling configuration
export const VOICE_ENABLED = process.env.VOICE_ENABLED === 'true';
export const VOICE_PORT = parseInt(process.env.VOICE_PORT || '3340', 10);
export const VOICE_GROUP = process.env.VOICE_GROUP || 'main';
export const VOICE_ALLOWED_CALLERS = (process.env.VOICE_ALLOWED_CALLERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const VOICE_GREETING = process.env.VOICE_GREETING || "Hey Rick, what's up?";
export const VOICE_MAX_DURATION = parseInt(process.env.VOICE_MAX_DURATION || '600000', 10);
export const VOICE_AUDIO_DIR = path.resolve(DATA_DIR, 'voice-audio');

export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
export const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';

export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
export const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';

export const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || '';
export const NGROK_DOMAIN = process.env.NGROK_DOMAIN || '';

// SMS configuration
export const SMS_ENABLED = process.env.SMS_ENABLED === 'true';
export const SMS_GROUP = process.env.SMS_GROUP || 'main';
export const SMS_ALLOWED_SENDERS = (process.env.SMS_ALLOWED_SENDERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function parseSmsJid(jid: string): { phoneNumber: string } | null {
  if (!jid.startsWith('sms:twilio:')) return null;
  const parts = jid.split(':');
  if (parts.length === 3) {
    return { phoneNumber: parts[2] };
  }
  return null;
}

export function buildSmsJid(phoneNumber: string): string {
  return `sms:twilio:${phoneNumber}`;
}

export function parseVoiceJid(jid: string): { callSid: string } | null {
  if (!jid.startsWith('voice:twilio:')) return null;
  const parts = jid.split(':');
  if (parts.length === 3) {
    return { callSid: parts[2] };
  }
  return null;
}

export function buildVoiceJid(callSid: string): string {
  return `voice:twilio:${callSid}`;
}
