#!/usr/bin/env node
/**
 * hydra — CLI entry point
 *
 * Dispatches to command modules via dynamic import for fast startup.
 */

import 'dotenv/config';
import { bold, dim, error } from './format.js';

type CommandModule = { run: (args: string[]) => Promise<void> };

// Suppress pino logs for CLI commands (they import config.ts which logs at module init)
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'silent';
}

const commands: Record<string, () => Promise<CommandModule>> = {
  up:       () => import('./commands/up.js') as Promise<CommandModule>,
  down:     () => import('./commands/down.js') as Promise<CommandModule>,
  status:   () => import('./commands/status.js') as Promise<CommandModule>,
  exec:     () => import('./commands/exec.js') as Promise<CommandModule>,
  agents:   () => import('./commands/agents.js') as Promise<CommandModule>,
  tasks:    () => import('./commands/tasks.js') as Promise<CommandModule>,
  logs:     () => import('./commands/logs.js') as Promise<CommandModule>,
};

// Compound commands: "agent create", "config validate"
const compoundCommands: Record<string, Record<string, () => Promise<CommandModule>>> = {
  agent: {
    create: () => import('./commands/agent-create.js') as Promise<CommandModule>,
  },
  config: {
    validate: () => import('./commands/config-validate.js') as Promise<CommandModule>,
  },
};

function printUsage(): void {
  console.log(`\n${bold('hydra')} — CLI for managing Hydra agents\n`);
  console.log('Usage: hydra <command> [options]\n');
  console.log('Commands:');
  console.log(`  ${bold('up')} [-f|--foreground]     Start the orchestrator`);
  console.log(`  ${bold('down')}                     Stop the orchestrator`);
  console.log(`  ${bold('status')}                   Orchestrator status + agents`);
  console.log(`  ${bold('exec')} <agent> [args...]   Interactive Claude Code session`);
  console.log(`  ${bold('agents')}                   List all agents`);
  console.log(`  ${bold('agent create')}             Create a new agent`);
  console.log(`  ${bold('tasks')}                    List scheduled tasks`);
  console.log(`  ${bold('logs')} [agent]             Tail orchestrator or agent logs`);
  console.log(`  ${bold('config validate')}          Validate hydra.yaml`);
  console.log();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  const [first, second, ...rest] = args;

  // Check compound commands first
  if (first in compoundCommands && second && second in compoundCommands[first]) {
    const mod = await compoundCommands[first][second]();
    return mod.run(rest);
  }

  // Simple commands
  if (first in commands) {
    const mod = await commands[first]();
    return mod.run(args.slice(1));
  }

  error(`Unknown command: ${first}`);
  console.log(dim(`Run "hydra --help" for usage`));
  process.exit(1);
}

main().catch(err => {
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
