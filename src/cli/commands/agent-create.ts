/**
 * hydra agent create — Create a new agent interactively
 *
 * Usage:
 *   hydra agent create
 *   hydra agent create --name "Merlin" --folder merlin
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { success, error } from '../format.js';

const PROJECT_ROOT = process.cwd();
const AGENTS_DIR = path.resolve(PROJECT_ROOT, 'agents');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'hydra.yaml');

function prompt(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

export async function run(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  let name: string;
  let folder: string;

  if (flags.name && flags.folder) {
    name = flags.name;
    folder = flags.folder;
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      name = await prompt(rl, 'Agent name');
      if (!name) { error('Name is required'); process.exit(1); }
      folder = await prompt(rl, 'Folder name', name.toLowerCase().replace(/\s+/g, '-'));
    } finally {
      rl.close();
    }
  }

  // Validate folder name
  if (!/^[a-z0-9_-]+$/.test(folder)) {
    error('Folder name must be lowercase alphanumeric with hyphens/underscores');
    process.exit(1);
  }

  // Check if folder already exists
  const agentDir = path.join(AGENTS_DIR, folder);
  if (fs.existsSync(agentDir)) {
    error(`Directory agents/${folder}/ already exists`);
    process.exit(1);
  }

  // Create agent directory with template CLAUDE.md
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'CLAUDE.md'),
    `# ${name}

You are ${name}. Describe your persona and capabilities here.

## Filesystem Layout

Your working directory is \`/workspace/agent\` — this is your agent's persistent home folder.

| Path | Description |
|------|-------------|
| \`/workspace/agent/\` | Your agent folder (working directory). Files here persist across sessions. |
| \`/workspace/extra/\` | Additional host directories mounted via hydra.yaml. |
| \`/workspace/ipc/\` | IPC directory for messaging the orchestrator. |
| \`/workspace/global/\` | Shared read-only directory visible to all agents (if it exists). |

## Memory

You have persistent memory via the mem0 MCP server (\`mcp__mem0__*\` tools). Use it to maintain context across conversations.

### Before Responding

Search memory at the start of every conversation to load relevant context:
- \`memory_search\` with the current topic before answering or making decisions
- Without this, you start from scratch every time

### What to Remember

Store anything that would be painful to re-explain or re-discover:
- Key decisions and their rationale
- User preferences and recurring instructions
- Project context, architecture choices, important details
- Tricky problems and how they were resolved

### How to Store

Be specific and self-contained. Each memory should make sense on its own.

Good: "User prefers TypeScript with strict mode and Zod for validation"
Bad: "Uses TypeScript"

### When to Forget

Use \`memory_forget\` to remove memories that are outdated or wrong. Stale memories are worse than no memories.
`,
  );

  // Append agent to hydra.yaml
  if (!fs.existsSync(CONFIG_PATH)) {
    error('hydra.yaml not found. Create one first.');
    process.exit(1);
  }

  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config = parseYaml(content) || {};

  if (!config.agents) config.agents = [];
  config.agents.push({
    name,
    folder,
  });

  fs.writeFileSync(CONFIG_PATH, stringifyYaml(config, { indent: 2 }));

  success(`Created agent "${name}"`);
  console.log(`  Directory: agents/${folder}/`);
  console.log(`  Config:    hydra.yaml updated`);
  console.log(`\nNext: edit agents/${folder}/CLAUDE.md to set the persona`);
}
