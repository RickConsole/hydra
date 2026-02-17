/**
 * hydra config validate — Validate hydra.yaml configuration
 *
 * Usage:
 *   hydra config validate [path/to/hydra.yaml]
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { loadHydraConfig } from '../../hydra-config.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { success, error as fmtError, warn } from '../format.js';

export async function run(args: string[]): Promise<void> {
  const configPath = args[0] || path.join(process.cwd(), 'hydra.yaml');

  console.log(`Validating configuration: ${configPath}\n`);

  if (!fs.existsSync(configPath)) {
    fmtError(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  try {
    // First, parse without env resolution to show raw structure
    const content = fs.readFileSync(configPath, 'utf-8');
    const rawConfig = configPath.endsWith('.json')
      ? JSON.parse(content)
      : parseYaml(content);

    console.log('Raw configuration structure:');
    console.log(`  version: ${rawConfig.version || '(missing)'}`);
    console.log(`  project: ${rawConfig.project || '(not set)'}`);
    console.log(`  bots: ${Object.keys(rawConfig.bots || {}).length} defined`);
    console.log(`  agents: ${(rawConfig.agents || []).length} defined`);
    console.log();

    // Now try full validation with env resolution
    console.log('Validating with environment variable resolution...');

    const config = loadHydraConfig(configPath);

    success('Configuration is valid!\n');

    // Show summary
    console.log('Summary:');
    console.log(`  Bots:`);
    for (const [key, botEntry] of Object.entries(config.bots)) {
      const bot = botEntry as { name: string; platform: string };
      console.log(`    - ${key}: ${bot.name} (${bot.platform})`);
    }

    console.log(`  Agents:`);
    for (const agent of config.agents) {
      const containerInfo = agent.container
        ? ` [${agent.container.image}, ${agent.container.network_mode}]`
        : '';
      console.log(`    - ${agent.folder}: ${agent.name}${containerInfo}`);
    }

    if (config.memory) {
      console.log(`  Memory: ${config.memory.provider}${config.memory.qdrant_url ? ` (${config.memory.qdrant_url})` : ''}`);
    }

    // Check for common issues
    console.log('\nChecks:');

    // Check all agents reference valid bots
    const botKeys = new Set(Object.keys(config.bots));
    let hasOrphanedAgents = false;
    for (const agent of config.agents) {
      if (agent.bot && !botKeys.has(agent.bot)) {
        warn(`Agent "${agent.name}" references undefined bot "${agent.bot}"`);
        hasOrphanedAgents = true;
      }
    }
    if (!hasOrphanedAgents && config.agents.length > 0) {
      success('All agents reference valid bots');
    }

    // Check for duplicate folders
    const folders = config.agents.map(a => a.folder);
    const duplicateFolders = folders.filter((f, i) => folders.indexOf(f) !== i);
    if (duplicateFolders.length > 0) {
      warn(`Duplicate agent folders: ${duplicateFolders.join(', ')}`);
    } else if (folders.length > 0) {
      success('No duplicate agent folders');
    }

    // Check agents/ directories exist
    const agentsDir = path.join(process.cwd(), 'agents');
    if (fs.existsSync(agentsDir)) {
      let missingDirs = false;
      for (const agent of config.agents) {
        const agentDir = path.join(agentsDir, agent.folder);
        if (!fs.existsSync(agentDir)) {
          warn(`Missing directory: agents/${agent.folder}/`);
          missingDirs = true;
        }
      }
      if (!missingDirs && config.agents.length > 0) {
        success('All agent directories exist');
      }
    }

  } catch (err) {
    if (err instanceof z.ZodError) {
      fmtError('Validation errors:\n');
      for (const issue of err.issues) {
        console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
      }
    } else {
      fmtError(`Validation failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}
