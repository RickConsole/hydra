/**
 * Hydra Unified Configuration
 *
 * Single YAML file that consolidates all configuration:
 * - Bots/channels
 * - Agents (groups)
 * - Security policies
 * - Integrations (voice, SMS)
 * - Memory settings
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYamlContent, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Bot/Channel configuration
 */
const BotSchema = z.object({
  name: z.string().describe('Display name and trigger name (@Name)'),
  token: z.string().describe('Bot API token (can be env:VAR_NAME reference)'),
  platform: z.enum(['telegram', 'slack', 'discord', 'whatsapp']).default('telegram'),
});

/**
 * Additional mount configuration
 */
const MountSchema = z.object({
  host_path: z.string().describe('Absolute path on host (supports ~)'),
  container_path: z.string().describe('Path inside container under /workspace/extra/'),
  readonly: z.boolean().default(true),
});

/**
 * Container configuration for an agent
 */
const ContainerConfigSchema = z.object({
  image: z.string().default('nanoclaw-agent:latest'),
  network_mode: z.enum(['bridge', 'host', 'none']).default('bridge'),
  timeout: z.number().default(300000).describe('Timeout in ms'),
  memory_limit: z.string().optional().describe('e.g., "2Gi"'),
  cpu_limit: z.string().optional().describe('e.g., "1"'),
  mounts: z.array(MountSchema).default(() => []),
  env: z.record(z.string(), z.string()).default(() => ({})),
});

/**
 * Agent (group) definition
 */
const AgentSchema = z.object({
  name: z.string().describe('Display name for the agent'),
  folder: z.string().describe('Folder name under groups/'),
  trigger: z.string().describe('Trigger word (e.g., "@Merlin")'),
  bot: z.string().describe('Which bot this agent uses (key from bots section)'),
  chat_id: z.string().describe('Chat/group ID for this agent'),
  persona: z.string().optional().describe('Inline persona (alternative to CLAUDE.md file)'),
  container: ContainerConfigSchema.optional(),
});

/**
 * Mount security allowlist
 */
const MountSecuritySchema = z.object({
  allowed_roots: z.array(z.object({
    path: z.string(),
    allow_read_write: z.boolean().default(false),
    description: z.string().optional(),
  })).default(() => []),
  blocked_patterns: z.array(z.string()).default(() => ['password', 'secret', 'token', '.ssh', '.gnupg']),
  non_main_readonly: z.boolean().default(true),
});

/**
 * Voice calling configuration
 */
const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().default(3340),
  group: z.string().default('main'),
  allowed_callers: z.array(z.string()).default(() => []),
  greeting: z.string().default("Hey, what's up?"),
  max_duration: z.number().default(600000),
  twilio: z.object({
    account_sid: z.string(),
    auth_token: z.string(),
    phone_number: z.string(),
  }).optional(),
  elevenlabs: z.object({
    api_key: z.string(),
    voice_id: z.string().default('JBFqnCBsd6RMkjVDRZzb'),
    model_id: z.string().default('eleven_turbo_v2_5'),
  }).optional(),
  ngrok: z.object({
    authtoken: z.string(),
    domain: z.string(),
  }).optional(),
});

/**
 * SMS configuration
 */
const SmsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  group: z.string().default('main'),
  allowed_senders: z.array(z.string()).default([]),
});

/**
 * Memory configuration
 */
const MemoryConfigSchema = z.object({
  provider: z.enum(['mem0', 'postgres', 'none']).default('mem0'),
  self_hosted: z.boolean().default(false),
  endpoint: z.string().optional(),
  api_key: z.string().optional().describe('Can be env:VAR_NAME reference'),
});

/**
 * Runtime settings
 */
const RuntimeConfigSchema = z.object({
  poll_interval: z.number().default(2000),
  scheduler_poll_interval: z.number().default(60000),
  ipc_poll_interval: z.number().default(1000),
  log_level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  timezone: z.string().optional(),
});

/**
 * Root configuration schema
 */
export const HydraConfigSchema = z.object({
  version: z.literal('1').default('1'),
  project: z.string().optional().describe('Project/org name'),

  // Bots (communication channels)
  bots: z.record(z.string(), BotSchema).default(() => ({})),

  // Agents (groups)
  agents: z.array(AgentSchema).default(() => []),

  // Security
  security: z.object({
    mounts: MountSecuritySchema.optional(),
  }).default(() => ({})),

  // Integrations
  voice: VoiceConfigSchema.optional(),
  sms: SmsConfigSchema.optional(),

  // Memory
  memory: MemoryConfigSchema.optional(),

  // Runtime
  runtime: RuntimeConfigSchema.optional(),
});

export type HydraConfig = z.infer<typeof HydraConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type BotConfig = z.infer<typeof BotSchema>;
export type ContainerConfig = z.infer<typeof ContainerConfigSchema>;

// ============================================================================
// Environment Variable Resolution
// ============================================================================

/**
 * Resolve env: references in config values
 * e.g., "env:TELEGRAM_BOT_TOKEN" → process.env.TELEGRAM_BOT_TOKEN
 */
function resolveEnvRef(value: string): string {
  if (value.startsWith('env:')) {
    const envVar = value.slice(4);
    const resolved = process.env[envVar];
    if (!resolved) {
      throw new Error(`Environment variable ${envVar} is not set (referenced as ${value})`);
    }
    return resolved;
  }
  return value;
}

/**
 * Deep-resolve all env: references in an object
 */
function resolveEnvRefs(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvRef(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvRefs);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvRefs(value);
    }
    return result;
  }
  return obj;
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Parse YAML content using the yaml package
 */
function parseYaml(content: string): unknown {
  return parseYamlContent(content);
}

/**
 * Load configuration from hydra.yaml (or hydra.json)
 */
export function loadHydraConfig(configPath?: string): HydraConfig {
  const searchPaths = configPath
    ? [configPath]
    : [
        path.join(process.cwd(), 'hydra.yaml'),
        path.join(process.cwd(), 'hydra.yml'),
        path.join(process.cwd(), 'hydra.json'),
      ];

  let configContent: string | null = null;
  let foundPath: string | null = null;

  for (const searchPath of searchPaths) {
    if (fs.existsSync(searchPath)) {
      configContent = fs.readFileSync(searchPath, 'utf-8');
      foundPath = searchPath;
      break;
    }
  }

  if (!configContent || !foundPath) {
    // Return empty config with defaults if no config file exists
    return HydraConfigSchema.parse({});
  }

  // Parse YAML/JSON
  let rawConfig: unknown;
  if (foundPath.endsWith('.json')) {
    rawConfig = JSON.parse(configContent);
  } else {
    rawConfig = parseYaml(configContent);
  }

  // Resolve env: references
  const resolvedConfig = resolveEnvRefs(rawConfig);

  // Validate and return
  return HydraConfigSchema.parse(resolvedConfig);
}

// ============================================================================
// Migration Helpers
// ============================================================================

/**
 * Generate hydra.yaml from existing config files
 * This helps migrate from the old scattered config to unified format
 */
export function generateConfigFromExisting(projectRoot: string): HydraConfig {
  const config: Partial<HydraConfig> = {
    version: '1',
  };

  // Load bots.json if exists
  const botsPath = path.join(projectRoot, 'data', 'bots.json');
  if (fs.existsSync(botsPath)) {
    const botsData = JSON.parse(fs.readFileSync(botsPath, 'utf-8'));
    config.bots = {};
    for (const [key, value] of Object.entries(botsData as Record<string, { token: string; name: string }>)) {
      config.bots[key] = {
        name: value.name,
        token: `env:${key.toUpperCase()}_BOT_TOKEN`, // Reference env var instead of hardcoding
        platform: 'telegram',
      };
    }
  }

  // Load registered_groups.json if exists
  const groupsPath = path.join(projectRoot, 'data', 'registered_groups.json');
  if (fs.existsSync(groupsPath)) {
    const groupsData = JSON.parse(fs.readFileSync(groupsPath, 'utf-8'));
    config.agents = [];

    for (const [jid, group] of Object.entries(groupsData as Record<string, {
      name: string;
      folder: string;
      trigger: string;
      containerConfig?: {
        image?: string;
        networkMode?: string;
        additionalMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
      };
    }>)) {
      // Parse JID to get bot and chat_id
      const parts = jid.split(':');
      let bot = 'default';
      let chatId = jid;

      if (parts[0] === 'telegram' && parts.length >= 3) {
        bot = parts[1];
        chatId = parts[2];
      }

      const agent: AgentConfig = {
        name: group.name,
        folder: group.folder,
        trigger: group.trigger,
        bot,
        chat_id: chatId,
      };

      // Convert container config
      if (group.containerConfig) {
        agent.container = {
          image: group.containerConfig.image || 'nanoclaw-agent:latest',
          network_mode: (group.containerConfig.networkMode as 'bridge' | 'host' | 'none') || 'bridge',
          timeout: 300000,
          mounts: (group.containerConfig.additionalMounts || []).map(m => ({
            host_path: m.hostPath,
            container_path: m.containerPath,
            readonly: m.readonly ?? true,
          })),
          env: {},
        };
      }

      config.agents!.push(agent);
    }
  }

  // Load mount allowlist if exists
  const homeDir = process.env.HOME || '/Users/user';
  const allowlistPath = path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json');
  if (fs.existsSync(allowlistPath)) {
    const allowlistData = JSON.parse(fs.readFileSync(allowlistPath, 'utf-8'));
    config.security = {
      mounts: {
        allowed_roots: (allowlistData.allowedRoots || []).map((r: { path: string; allowReadWrite: boolean; description?: string }) => ({
          path: r.path,
          allow_read_write: r.allowReadWrite,
          description: r.description,
        })),
        blocked_patterns: allowlistData.blockedPatterns || [],
        non_main_readonly: allowlistData.nonMainReadOnly ?? true,
      },
    };
  }

  // Check for voice/SMS from .env
  if (process.env.VOICE_ENABLED === 'true') {
    config.voice = {
      enabled: true,
      port: parseInt(process.env.VOICE_PORT || '3340', 10),
      group: process.env.VOICE_GROUP || 'main',
      allowed_callers: (process.env.VOICE_ALLOWED_CALLERS || '').split(',').filter(Boolean),
      greeting: process.env.VOICE_GREETING || "Hey, what's up?",
      max_duration: parseInt(process.env.VOICE_MAX_DURATION || '600000', 10),
    };

    if (process.env.TWILIO_ACCOUNT_SID) {
      config.voice.twilio = {
        account_sid: 'env:TWILIO_ACCOUNT_SID',
        auth_token: 'env:TWILIO_AUTH_TOKEN',
        phone_number: 'env:TWILIO_PHONE_NUMBER',
      };
    }

    if (process.env.ELEVENLABS_API_KEY) {
      config.voice.elevenlabs = {
        api_key: 'env:ELEVENLABS_API_KEY',
        voice_id: process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
        model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
      };
    }

    if (process.env.NGROK_AUTHTOKEN) {
      config.voice.ngrok = {
        authtoken: 'env:NGROK_AUTHTOKEN',
        domain: 'env:NGROK_DOMAIN',
      };
    }
  }

  if (process.env.SMS_ENABLED === 'true') {
    config.sms = {
      enabled: true,
      group: process.env.SMS_GROUP || 'main',
      allowed_senders: (process.env.SMS_ALLOWED_SENDERS || '').split(',').filter(Boolean),
    };
  }

  return HydraConfigSchema.parse(config);
}

/**
 * Write config to file (YAML or JSON based on extension)
 */
export function writeHydraConfig(config: HydraConfig, configPath: string): void {
  if (configPath.endsWith('.json')) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } else {
    // Default to YAML
    fs.writeFileSync(configPath, stringifyYaml(config, { indent: 2 }));
  }
}

// ============================================================================
// Config Access Helpers
// ============================================================================

/**
 * Get agent by folder name
 */
export function getAgentByFolder(config: HydraConfig, folder: string): AgentConfig | undefined {
  return config.agents.find(a => a.folder === folder);
}

/**
 * Get bot config by key
 */
export function getBotByKey(config: HydraConfig, key: string): BotConfig | undefined {
  return config.bots[key] as BotConfig | undefined;
}

/**
 * Build JID from agent config
 * For web-console-only agents (no bot), uses "web:console:{folder}"
 */
export function buildJidFromAgent(agent: AgentConfig): string {
  if (!agent.bot || !agent.chat_id) {
    // Web-console-only agent
    return `web:console:${agent.folder}`;
  }
  return `telegram:${agent.bot}:${agent.chat_id}`;
}

/**
 * Convert HydraConfig to legacy RegisteredGroups format
 * For backward compatibility during migration
 */
export function toLegacyRegisteredGroups(config: HydraConfig): Record<string, {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: {
    image?: string;
    networkMode?: 'bridge' | 'host' | 'none';
    additionalMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
  };
}> {
  const result: Record<string, {
    name: string;
    folder: string;
    trigger: string;
    added_at: string;
    containerConfig?: {
      image?: string;
      networkMode?: 'bridge' | 'host' | 'none';
      additionalMounts?: Array<{ hostPath: string; containerPath: string; readonly?: boolean }>;
    };
  }> = {};

  for (const agent of config.agents) {
    const jid = buildJidFromAgent(agent);
    result[jid] = {
      name: agent.name,
      folder: agent.folder,
      trigger: agent.trigger,
      added_at: new Date().toISOString(),
    };

    if (agent.container) {
      result[jid].containerConfig = {
        image: agent.container.image,
        networkMode: agent.container.network_mode,
        additionalMounts: agent.container.mounts.map(m => ({
          hostPath: m.host_path,
          containerPath: m.container_path,
          readonly: m.readonly,
        })),
      };
    }
  }

  return result;
}

/**
 * Convert HydraConfig to legacy BotRegistry format
 */
export function toLegacyBotRegistry(config: HydraConfig): Record<string, { token: string; name: string }> {
  const result: Record<string, { token: string; name: string }> = {};

  for (const [key, botEntry] of Object.entries(config.bots)) {
    const bot = botEntry as BotConfig;
    result[key] = {
      token: bot.token,
      name: bot.name,
    };
  }

  return result;
}
