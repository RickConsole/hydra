/**
 * hydra up — Start the orchestrator daemon
 *
 * Usage:
 *   hydra up                  Start as background daemon
 *   hydra up -f|--foreground  Run in foreground (replaces npm run dev)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { success, error, warn, dim } from '../format.js';
import { needsInfraServices, startInfraServices } from '../infra.js';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
const PID_FILE = path.join(DATA_DIR, 'hydra.pid');
const LOG_FILE = path.join(DATA_DIR, 'hydra.log');

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function run(args: string[]): Promise<void> {
  const foreground = args.includes('-f') || args.includes('--foreground');

  // Check if already running
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (isRunning(pid)) {
      error(`Orchestrator is already running (PID ${pid})`);
      process.exit(1);
    }
    // Stale PID file — clean up
    fs.unlinkSync(PID_FILE);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Start infrastructure services if needed (Qdrant, Ollama)
  if (needsInfraServices()) {
    console.log(dim('Starting infrastructure (Qdrant, Ollama)...'));
    const ok = await startInfraServices();
    if (ok) {
      success('Infrastructure services started');
    } else {
      warn('Infrastructure services failed to start — continuing anyway');
    }
    console.log();
  }

  if (foreground) {
    // Run inline — replaces npm run dev
    const child = spawn('npx', ['tsx', path.join(PROJECT_ROOT, 'src/index.ts')], {
      stdio: 'inherit',
      cwd: PROJECT_ROOT,
      env: process.env,
    });

    // Write PID for status/down commands
    fs.writeFileSync(PID_FILE, String(child.pid));

    child.on('exit', (code) => {
      try { fs.unlinkSync(PID_FILE); } catch {}
      process.exit(code ?? 1);
    });

    // Forward signals
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => child.kill(sig));
    }
    return;
  }

  // Daemon mode — detached with log file
  const logFd = fs.openSync(LOG_FILE, 'a');

  const child = spawn('npx', ['tsx', path.join(PROJECT_ROOT, 'src/index.ts')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: PROJECT_ROOT,
    env: process.env,
  });

  if (!child.pid) {
    error('Failed to start orchestrator');
    fs.closeSync(logFd);
    process.exit(1);
  }

  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  fs.closeSync(logFd);

  success(`Orchestrator started (PID ${child.pid})`);
  console.log(dim(`  Logs: ${LOG_FILE}`));
}
