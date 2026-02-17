/**
 * hydra status — Show orchestrator status and agent overview
 */

import fs from 'fs';
import path from 'path';
import { bold, dim, green, red, table } from '../format.js';
import { loadHydraConfig } from '../../hydra-config.js';
import { needsInfraServices, getInfraStatus } from '../infra.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PID_FILE = path.join(DATA_DIR, 'hydra.pid');

export async function run(_args: string[]): Promise<void> {
  // Orchestrator status
  let running = false;
  let pid: number | null = null;

  if (fs.existsSync(PID_FILE)) {
    pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      // Stale PID
    }
  }

  if (running) {
    console.log(`${bold('Orchestrator:')} ${green('running')} ${dim(`(PID ${pid})`)}`);
  } else {
    console.log(`${bold('Orchestrator:')} ${red('stopped')}`);
  }

  // Infrastructure status
  if (needsInfraServices()) {
    const infra = await getInfraStatus();
    console.log(
      `${bold('Qdrant:')}        ${infra.qdrant ? green('running') : red('stopped')}`
    );
    console.log(
      `${bold('Ollama:')}        ${infra.ollama ? green('running') : red('stopped')}`
    );
  }

  console.log();

  // Agent overview
  let config;
  try {
    config = loadHydraConfig();
  } catch (err) {
    console.error('Could not load hydra.yaml:', err instanceof Error ? err.message : err);
    return;
  }

  if (config.agents.length === 0) {
    console.log(dim('No agents configured'));
    return;
  }

  const rows = config.agents.map(a => [
    a.folder,
    a.name,
    a.bot || dim('none'),
  ]);

  table(['FOLDER', 'NAME', 'BOT'], rows);
}
