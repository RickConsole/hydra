/**
 * Infrastructure service management — Qdrant, Ollama via docker compose.
 *
 * Only activated when memory.provider === 'qdrant' in hydra.yaml.
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadHydraConfig } from '../hydra-config.js';
import { warn } from './format.js';

const PROJECT_ROOT = process.cwd();
const COMPOSE_FILE = path.join(PROJECT_ROOT, 'docker-compose.yml');
const INFRA_SERVICES = ['qdrant', 'ollama', 'ollama-setup'];

/**
 * Detect available compose command.
 * Returns ["docker", "compose"] (v2 plugin) or ["docker-compose"] (v1), or null.
 */
export function getComposeCommand(): string[] | null {
  try {
    execSync('docker compose version', { stdio: 'ignore' });
    return ['docker', 'compose'];
  } catch {}

  try {
    execSync('docker-compose version', { stdio: 'ignore' });
    return ['docker-compose'];
  } catch {}

  return null;
}

/**
 * Check if infra services are needed:
 * - memory.provider is 'qdrant'
 * - docker-compose.yml exists
 * - compose command available
 */
export function needsInfraServices(): boolean {
  let config;
  try {
    config = loadHydraConfig();
  } catch {
    return false;
  }

  if (config.memory?.provider !== 'qdrant') return false;
  if (!fs.existsSync(COMPOSE_FILE)) return false;
  if (!getComposeCommand()) return false;

  return true;
}

/**
 * Start qdrant + ollama + ollama-setup via compose.
 * Returns true if started successfully.
 */
export async function startInfraServices(): Promise<boolean> {
  const compose = getComposeCommand();
  if (!compose) {
    warn('docker compose not found — skipping infrastructure services');
    return false;
  }

  if (!fs.existsSync(COMPOSE_FILE)) {
    warn('docker-compose.yml not found — skipping infrastructure services');
    return false;
  }

  const args = [
    ...compose.slice(1),
    '-f', COMPOSE_FILE,
    'up', '-d', '--wait',
    ...INFRA_SERVICES,
  ];

  const result = spawnSync(compose[0], args, {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });

  return result.status === 0;
}

/**
 * Stop infra services (compose stop — preserves volumes).
 */
export async function stopInfraServices(): Promise<void> {
  const compose = getComposeCommand();
  if (!compose) return;
  if (!fs.existsSync(COMPOSE_FILE)) return;

  const args = [
    ...compose.slice(1),
    '-f', COMPOSE_FILE,
    'stop',
    ...INFRA_SERVICES,
  ];

  spawnSync(compose[0], args, {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
}

/**
 * Check running status of qdrant and ollama containers.
 */
export async function getInfraStatus(): Promise<{ qdrant: boolean; ollama: boolean }> {
  const compose = getComposeCommand();
  if (!compose) return { qdrant: false, ollama: false };
  if (!fs.existsSync(COMPOSE_FILE)) return { qdrant: false, ollama: false };

  function isServiceRunning(service: string): boolean {
    try {
      const args = [
        ...compose!.slice(1),
        '-f', COMPOSE_FILE,
        'ps', '--status', 'running', '--format', '{{.Name}}',
        service,
      ];
      const output = execSync([compose![0], ...args].join(' '), {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return output.length > 0;
    } catch {
      return false;
    }
  }

  return {
    qdrant: isServiceRunning('qdrant'),
    ollama: isServiceRunning('ollama'),
  };
}
