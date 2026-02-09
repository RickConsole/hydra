/**
 * ngrok tunnel management for voice webhook URL.
 * Spawns ngrok as a child process, parses the public URL.
 */
import { spawn, execSync, ChildProcess } from 'child_process';

import { NGROK_AUTHTOKEN, NGROK_DOMAIN, VOICE_PORT } from './config.js';
import { logger } from './logger.js';

let ngrokProcess: ChildProcess | null = null;
let tunnelUrl = '';

export async function startTunnel(): Promise<string> {
  if (!NGROK_AUTHTOKEN) {
    throw new Error('NGROK_AUTHTOKEN is required for voice calling');
  }

  const args = ['http', String(VOICE_PORT), '--log', 'stdout', '--log-format', 'json'];
  if (NGROK_DOMAIN) {
    args.push('--domain', NGROK_DOMAIN);
  }

  // Kill any existing ngrok processes first to avoid domain conflicts
  try {
    execSync('pkill -f ngrok', { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // No existing ngrok to kill
  }

  return new Promise<string>((resolve, reject) => {
    const proc = spawn('ngrok', args, {
      env: { ...process.env, NGROK_AUTHTOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ngrokProcess = proc;
    let resolved = false;
    let stderrOutput = '';

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        // If we have a domain, we can construct the URL directly
        if (NGROK_DOMAIN) {
          logger.info({ domain: NGROK_DOMAIN }, 'Using configured ngrok domain');
          tunnelUrl = `https://${NGROK_DOMAIN}`;
          resolve(tunnelUrl);
        } else {
          reject(new Error('Timed out waiting for ngrok URL'));
        }
      }
    }, 10000);

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const log = JSON.parse(line);
          // Check for errors in JSON log output
          if (log.err && log.lvl === 'crit') {
            logger.error({ ngrokErr: log.err }, 'ngrok critical error');
          }
          if (log.url && log.url.startsWith('https://')) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              tunnelUrl = log.url;
              logger.info({ url: log.url }, 'ngrok tunnel established');
              resolve(tunnelUrl);
            }
          }
        } catch {
          // Not JSON, ignore
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      stderrOutput += text + '\n';
      logger.debug({ ngrok: text }, 'ngrok stderr');
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ngrok: ${err.message}`));
      }
    });

    proc.on('exit', (code) => {
      ngrokProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        const detail = stderrOutput.trim() ? `: ${stderrOutput.trim().slice(0, 200)}` : '';
        reject(new Error(`ngrok exited with code ${code}${detail}`));
      }
      logger.info({ code }, 'ngrok process exited');
    });
  });
}

export function stopTunnel(): void {
  if (ngrokProcess) {
    ngrokProcess.kill('SIGTERM');
    ngrokProcess = null;
    tunnelUrl = '';
    logger.info('ngrok tunnel stopped');
  }
}

export function getTunnelUrl(): string {
  return tunnelUrl;
}
