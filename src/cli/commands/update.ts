/**
 * hydra update — Rebuild agent containers with latest Claude Code
 *
 * Usage:
 *   hydra update          # rebuild containers (updates Claude Code)
 *   hydra update --full   # rebuild from scratch (no cache)
 */

import { execSync } from 'child_process';
import path from 'path';
import { bold, dim, error } from '../format.js';

export async function run(args: string[]): Promise<void> {
  const full = args.includes('--full') || args.includes('-f');

  const scriptDir = path.resolve(import.meta.dirname, '../../../container');
  const buildScript = path.join(scriptDir, 'build.sh');

  console.log(bold('Updating Hydra agent containers...'));
  if (full) {
    console.log(dim('Full rebuild (--no-cache) — this may take a while'));
  } else {
    console.log(dim('Rebuilding Claude Code layer (cached base layers)'));
  }
  console.log();

  try {
    execSync(`bash "${buildScript}"${full ? ' --full' : ''}`, {
      stdio: 'inherit',
      cwd: scriptDir,
    });
  } catch (err) {
    error('Container build failed');
    process.exit(1);
  }
}
