#!/usr/bin/env node
/**
 * Validation CLI: Validate hydra.yaml configuration
 *
 * Usage: npm run config:validate [path/to/hydra.yaml]
 */

import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { loadHydraConfig, HydraConfigSchema } from '../hydra-config.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const configPath = process.argv[2] || path.join(process.cwd(), 'hydra.yaml');

console.log(`Validating configuration: ${configPath}\n`);

if (!fs.existsSync(configPath)) {
  console.error(`❌ Config file not found: ${configPath}`);
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

  console.log('\n✓ Configuration is valid!\n');

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
    console.log(`    - ${agent.folder}: ${agent.name} (${agent.trigger})${containerInfo}`);
  }

  if (config.memory) {
    console.log(`  Memory: ${config.memory.provider}${config.memory.self_hosted ? ' (self-hosted)' : ''}`);
  }

  // Check for common issues
  console.log('\nChecks:');

  // Check all agents reference valid bots
  const botKeys = new Set(Object.keys(config.bots));
  let hasOrphanedAgents = false;
  for (const agent of config.agents) {
    if (agent.bot && !botKeys.has(agent.bot)) {
      console.log(`  ⚠ Agent "${agent.name}" references undefined bot "${agent.bot}"`);
      hasOrphanedAgents = true;
    }
  }
  if (!hasOrphanedAgents && config.agents.length > 0) {
    console.log('  ✓ All agents reference valid bots');
  }

  // Check for duplicate folders
  const folders = config.agents.map(a => a.folder);
  const duplicateFolders = folders.filter((f, i) => folders.indexOf(f) !== i);
  if (duplicateFolders.length > 0) {
    console.log(`  ⚠ Duplicate agent folders: ${duplicateFolders.join(', ')}`);
  } else if (folders.length > 0) {
    console.log('  ✓ No duplicate agent folders');
  }

  // Check groups/ directories exist
  const groupsDir = path.join(process.cwd(), 'groups');
  if (fs.existsSync(groupsDir)) {
    let missingDirs = false;
    for (const agent of config.agents) {
      const agentDir = path.join(groupsDir, agent.folder);
      if (!fs.existsSync(agentDir)) {
        console.log(`  ⚠ Missing directory: groups/${agent.folder}/`);
        missingDirs = true;
      }
    }
    if (!missingDirs && config.agents.length > 0) {
      console.log('  ✓ All agent directories exist');
    }
  }

} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Validation errors:\n');
    for (const issue of error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
  } else {
    console.error('❌ Validation failed:', error instanceof Error ? error.message : error);
  }
  process.exit(1);
}
