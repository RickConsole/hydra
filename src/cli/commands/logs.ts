/**
 * hydra logs — Tail orchestrator or agent logs
 *
 * Usage:
 *   hydra logs              Tail orchestrator log (data/hydra.log)
 *   hydra logs <agent>      Tail latest log for an agent
 *   hydra logs -n <lines>   Number of initial lines (default: 50)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { error, dim } from '../format.js';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
const AGENTS_DIR = path.resolve(PROJECT_ROOT, 'agents');
const LOG_FILE = path.join(DATA_DIR, 'hydra.log');

function findLatestLog(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

export async function run(args: string[]): Promise<void> {
  let lines = '50';
  let agent: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' && args[i + 1]) {
      lines = args[++i];
    } else if (!args[i].startsWith('-')) {
      agent = args[i];
    }
  }

  let logFile: string;

  if (agent) {
    // Find agent log directory
    const agentLogDir = path.join(AGENTS_DIR, agent, 'logs');
    const latest = findLatestLog(agentLogDir);
    if (!latest) {
      error(`No logs found for agent "${agent}" in agents/${agent}/logs/`);
      process.exit(1);
    }
    logFile = latest;
  } else {
    if (!fs.existsSync(LOG_FILE)) {
      error(`No orchestrator log found at ${LOG_FILE}`);
      console.log(dim('Start the orchestrator with `hydra up` first.'));
      process.exit(1);
    }
    logFile = LOG_FILE;
  }

  console.log(dim(`Tailing ${logFile} ...\n`));

  const tail = spawn('tail', ['-n', lines, '-f', logFile], {
    stdio: 'inherit',
  });

  // Forward signals so ctrl-c kills tail cleanly
  process.on('SIGINT', () => tail.kill('SIGINT'));
  process.on('SIGTERM', () => tail.kill('SIGTERM'));

  tail.on('exit', (code) => process.exit(code ?? 0));
}
