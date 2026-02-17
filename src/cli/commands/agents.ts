/**
 * hydra agents — List all configured agents
 */

import { dim, table } from '../format.js';
import { loadHydraConfig } from '../../hydra-config.js';

export async function run(_args: string[]): Promise<void> {
  let config;
  try {
    config = loadHydraConfig();
  } catch (err) {
    console.error('Could not load hydra.yaml:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (config.agents.length === 0) {
    console.log(dim('No agents configured. Run `hydra agent create` to add one.'));
    return;
  }

  const rows = config.agents.map(a => [
    a.folder,
    a.name,
    a.bot || dim('—'),
    a.chat_id || dim('—'),
  ]);

  table(['FOLDER', 'NAME', 'BOT', 'CHAT_ID'], rows);
}
