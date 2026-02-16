#!/usr/bin/env node
/**
 * Migration CLI: Generate hydra.yaml from existing scattered config files
 *
 * Usage: npm run config:migrate
 */

import 'dotenv/config';
import path from 'path';
import { generateConfigFromExisting, writeHydraConfig } from '../hydra-config.js';

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, 'hydra.yaml');

console.log('Migrating existing configuration to hydra.yaml...\n');
console.log(`Project root: ${projectRoot}`);

try {
  const config = generateConfigFromExisting(projectRoot);

  console.log('\nGenerated configuration:');
  console.log(`  - Bots: ${Object.keys(config.bots).length}`);
  console.log(`  - Agents: ${config.agents.length}`);
  console.log(`  - Voice: ${config.voice?.enabled ? 'enabled' : 'disabled'}`);
  console.log(`  - SMS: ${config.sms?.enabled ? 'enabled' : 'disabled'}`);

  if (config.security?.mounts) {
    console.log(`  - Mount roots: ${config.security.mounts.allowed_roots?.length || 0}`);
  }

  writeHydraConfig(config, outputPath);
  console.log(`\n✓ Configuration written to: ${outputPath}`);

  console.log('\nNext steps:');
  console.log('  1. Review hydra.yaml and adjust as needed');
  console.log('  2. Move sensitive tokens to environment variables');
  console.log('  3. Run `npm run config:validate` to verify');

} catch (error) {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
