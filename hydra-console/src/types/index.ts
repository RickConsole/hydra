// Hydra Console Types

// Agent types
export interface Agent {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'starting';
  platform: string;
  groupFolder: string;
  uptime?: number;
  lastMessage?: string;
}

// Chat types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  agentId: string;
}

export interface ChatState {
  messages: ChatMessage[];
  isTyping: boolean;
  connected: boolean;
}

// Config types
export interface HydraConfig {
  version: '1';
  project?: string;
  bots: Record<string, BotConfig>;
  agents: AgentConfig[];
  security?: SecurityConfig;
  voice?: VoiceConfig;
  sms?: SmsConfig;
  memory?: MemoryConfig;
  runtime?: RuntimeConfig;
}

export interface BotConfig {
  platform: 'telegram' | 'whatsapp' | 'slack' | 'discord' | 'web';
  token?: string;
  enabled?: boolean;
}

export interface AgentConfig {
  id: string;
  name: string;
  bot: string;
  groupFolder: string;
  trigger?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SecurityConfig {
  mounts?: MountSecurityConfig;
}

export interface MountSecurityConfig {
  allowlist?: string[];
  denylist?: string[];
  readOnlyPaths?: string[];
}

export interface VoiceConfig {
  enabled?: boolean;
  provider?: string;
}

export interface SmsConfig {
  enabled?: boolean;
  provider?: string;
}

export interface MemoryConfig {
  provider?: 'mem0' | 'local';
  endpoint?: string;
}

export interface RuntimeConfig {
  containerImage?: string;
  resourceLimits?: {
    memory?: string;
    cpu?: string;
  };
}

// Memory types
export interface Memory {
  id: string;
  content: string;
  createdAt: Date;
  agentId: string;
  metadata?: Record<string, unknown>;
}

// API response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors?: Array<{
    path: string;
    message: string;
  }>;
}

// WebSocket event types
export type WsEventType =
  | 'chat:message'
  | 'chat:typing'
  | 'agent:status'
  | 'config:changed'
  | 'system:error';

export interface WsEvent<T = unknown> {
  type: WsEventType;
  payload: T;
  timestamp: Date;
}
