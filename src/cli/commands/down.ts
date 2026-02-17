/**
 * hydra down — Stop the orchestrator daemon
 */

import fs from 'fs';
import path from 'path';
import { success, error, warn, dim } from '../format.js';
import { needsInfraServices, stopInfraServices } from '../infra.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const PID_FILE = path.join(DATA_DIR, 'hydra.pid');

export async function run(_args: string[]): Promise<void> {
  let orchestratorWasRunning = false;

  if (!fs.existsSync(PID_FILE)) {
    warn('Orchestrator is not running (no PID file)');
  } else {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);

    try {
      process.kill(pid, 0); // Check if alive
      orchestratorWasRunning = true;
    } catch {
      warn('Orchestrator is not running (stale PID file)');
      fs.unlinkSync(PID_FILE);
    }

    if (orchestratorWasRunning) {
      process.kill(pid, 'SIGTERM');

      // Wait for process to exit (up to 10 seconds)
      const deadline = Date.now() + 10_000;
      let stopped = false;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise(r => setTimeout(r, 200));
        } catch {
          stopped = true;
          break;
        }
      }

      if (stopped) {
        try { fs.unlinkSync(PID_FILE); } catch {}
        success('Orchestrator stopped');
      } else {
        error(`Orchestrator (PID ${pid}) did not stop within 10 seconds`);
        await stopInfra();
        process.exit(1);
      }
    }
  }

  await stopInfra();
}

async function stopInfra(): Promise<void> {
  if (needsInfraServices()) {
    console.log();
    console.log(dim('Stopping infrastructure (Qdrant, Ollama)...'));
    await stopInfraServices();
    success('Infrastructure services stopped');
  }
}
