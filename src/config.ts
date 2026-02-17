/**
 * Hydra Configuration Module
 *
 * This module provides configuration for the Hydra agent platform.
 * It loads from hydra.yaml (unified config) if available, falling back
 * to legacy configuration sources (env vars, JSON files) for backward compatibility.
 */

import fs from 'fs';
import path from 'path';

import { BotRegistry } from './types.js';
import {
  loadHydraConfig,
  toLegacyBotRegistry,
  toLegacyRegisteredGroups,
  HydraConfig,
} from './hydra-config.js';
import { logger } from './logger.js';

// ============================================================================
// Load Unified Config
// ============================================================================

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Try to load hydra.yaml, fall back to legacy config
let hydraConfig: HydraConfig | null = null;
let usingUnifiedConfig = false;

try {
  const configPaths = [
    path.join(PROJECT_ROOT, 'hydra.yaml'),
    path.join(PROJECT_ROOT, 'hydra.yml'),
    path.join(PROJECT_ROOT, 'hydra.json'),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      hydraConfig = loadHydraConfig(configPath);
      usingUnifiedConfig = true;
      logger.info({ configPath }, 'Loaded unified hydra config');
      break;
    }
  }
} catch (err) {
  logger.warn({ err }, 'Failed to load hydra config, falling back to legacy');
}

// ============================================================================
// Runtime Settings (from hydra.yaml or defaults)
// ============================================================================

export const POLL_INTERVAL = hydraConfig?.runtime?.poll_interval ?? 2000;
export const SCHEDULER_POLL_INTERVAL = hydraConfig?.runtime?.scheduler_poll_interval ?? 60000;
export const IPC_POLL_INTERVAL = hydraConfig?.runtime?.ipc_poll_interval ?? 1000;

// ============================================================================
// Path Configuration
// ============================================================================

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const AGENTS_DIR = path.resolve(PROJECT_ROOT, 'agents');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

// ============================================================================
// Container Configuration
// ============================================================================

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

// ============================================================================
// Timezone
// ============================================================================

export const TIMEZONE =
  hydraConfig?.runtime?.timezone ||
  process.env.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone;

// ============================================================================
// Bot Registry
// ============================================================================

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getTriggerPattern(botName: string): RegExp {
  return new RegExp(`^@${escapeRegex(botName)}\\b`, 'i');
}

/**
 * Load bot registry from hydra.yaml, data/bots.json, or env vars.
 * Returns empty registry if no bots configured (web-console-only mode).
 */
export function loadBotRegistry(): BotRegistry {
  // If unified config is loaded, use that (even if empty - allows web-console-only mode)
  if (usingUnifiedConfig && hydraConfig) {
    if (Object.keys(hydraConfig.bots).length > 0) {
      const registry = toLegacyBotRegistry(hydraConfig);
      logger.debug({ bots: Object.keys(registry) }, 'Bot registry loaded from hydra config');
      return registry;
    }
    // Empty bots in hydra.yaml = web-console-only mode
    logger.info('No bots configured in hydra.yaml - running in web-console-only mode');
    return {};
  }

  // Fall back to legacy: data/bots.json
  const botsPath = path.join(DATA_DIR, 'bots.json');
  if (fs.existsSync(botsPath)) {
    return JSON.parse(fs.readFileSync(botsPath, 'utf-8')) as BotRegistry;
  }

  // Fall back to legacy: env vars
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // No bots configured anywhere - this is fine for web-console-only mode
    logger.info('No bot configuration found - running in web-console-only mode');
    return {};
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
 * Load registered groups from hydra.yaml or data/registered_groups.json.
 */
export function loadRegisteredGroups(): Record<string, import('./types.js').RegisteredGroup> {
  // If unified config is loaded and has agents, use that
  if (usingUnifiedConfig && hydraConfig && hydraConfig.agents.length > 0) {
    const groups = toLegacyRegisteredGroups(hydraConfig);
    logger.debug({ count: Object.keys(groups).length }, 'Groups loaded from hydra config');
    return groups;
  }

  // Fall back to legacy: data/registered_groups.json
  const groupsPath = path.join(DATA_DIR, 'registered_groups.json');
  if (fs.existsSync(groupsPath)) {
    return JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
  }

  return {};
}

// ============================================================================
// JID Parsing Utilities
// ============================================================================

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

// ============================================================================
// Exported Config State
// ============================================================================

/**
 * Returns true if using unified hydra.yaml config
 */
export function isUsingUnifiedConfig(): boolean {
  return usingUnifiedConfig;
}

/**
 * Returns the loaded HydraConfig if using unified config, null otherwise
 */
export function getHydraConfig(): HydraConfig | null {
  return hydraConfig;
}

/**
 * Get log level from config or env
 */
export function getLogLevel(): string {
  return hydraConfig?.runtime?.log_level ?? process.env.LOG_LEVEL ?? 'info';
}
