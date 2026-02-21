/**
 * Secrets management for Hydra agent containers.
 *
 * Reads secrets from ~/.config/hydra/secrets.env (outside project root,
 * never mountable by containers) and resolves them for container injection
 * via Docker -e flags.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const SECRETS_ENV_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.config',
  'hydra',
  'secrets.env',
);

/** Env vars injected into every container regardless of agent config */
export const BASE_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MEM0_API_KEY',
  'QDRANT_URL',
  'OLLAMA_URL',
  'OPENAI_API_KEY',
  'LITELLM_API_KEY',
];

let secretsCache: Record<string, string> | null = null;

/**
 * Parse .env file content into key-value pairs.
 * Handles comments, blank lines, single/double quoting.
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1);

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Load and cache secrets from ~/.config/hydra/secrets.env.
 * Returns empty object if file doesn't exist.
 */
export function loadSecrets(): Record<string, string> {
  if (secretsCache !== null) return secretsCache;

  try {
    if (fs.existsSync(SECRETS_ENV_PATH)) {
      const content = fs.readFileSync(SECRETS_ENV_PATH, 'utf-8');
      secretsCache = parseDotenv(content);
    } else {
      secretsCache = {};
    }
  } catch {
    secretsCache = {};
  }

  return secretsCache;
}

/** Clear cached secrets (for reload/testing). */
export function clearSecretsCache(): void {
  secretsCache = null;
}

/**
 * Resolve a `secret:VAR_NAME` reference from secrets.env.
 * Plain values are returned as-is, so this is safe to call unconditionally.
 *
 * Example in hydra.yaml:
 *   api_key: secret:LITELLM_API_KEY
 */
export function resolveSecretRef(value: string): string {
  if (!value.startsWith('secret:')) return value;
  const key = value.slice(7);
  return loadSecrets()[key] ?? value;
}

/**
 * Resolve secrets for a container. Merges BASE_VARS with per-agent
 * declared secrets, looks up values from secrets.env, and returns
 * only keys that have values.
 */
export function resolveContainerSecrets(
  declaredSecrets: string[],
): Record<string, string> {
  const secrets = loadSecrets();
  const allKeys = [...new Set([...BASE_VARS, ...declaredSecrets])];
  const result: Record<string, string> = {};

  for (const key of allKeys) {
    if (secrets[key] !== undefined) {
      result[key] = secrets[key];
    }
  }

  return result;
}
