export interface BotConfig {
  token: string;
  name: string; // Display name + trigger name (@Name)
}

export type BotRegistry = Record<string, BotConfig>; // key → config

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath: string; // Path inside container (under /workspace/extra/)
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  image?: string; // Container image to use (default: nanoclaw-agent:latest)
  networkMode?: 'bridge' | 'host' | 'none'; // Docker network mode (default: bridge)
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  env?: Record<string, string>;
  allowedEnvVars?: string[]; // Additional .env keys this group can access (beyond base auth vars)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
}

export interface Session {
  [folder: string]: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  last_run_status: 'success' | 'error' | null;
  last_error: string | null;
  status: 'active' | 'paused' | 'completed' | 'failed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// Voice calling types
export type VoiceCallState = 'greeting' | 'gathering' | 'processing' | 'ended';

export interface ActiveCall {
  callSid: string;
  callerNumber: string;
  state: VoiceCallState;
  startedAt: number;
  lastActivity: number;
  // Queued response from agent, ready to be played
  pendingResponse?: string; // path to MP3 file
  pendingResponseText?: string; // text for logging
}
