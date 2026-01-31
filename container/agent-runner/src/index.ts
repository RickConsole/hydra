/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createIpcMcp } from './ipc-mcp.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  // Write to stdout as JSON (this is how the host process receives results)
  console.log(JSON.stringify(output));
}

function log(message: string): void {
  // Write logs to stderr so they don't interfere with JSON output
  console.error(`[agent-runner] ${message}`);
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Create IPC-based MCP for communicating back to host
  const ipcMcp = createIpcMcp({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  });

  let result: string | null = null;
  let newSessionId: string | undefined;

  try {
    log('Starting agent...');

    for await (const message of query({
      prompt: input.prompt,
      options: {
        cwd: '/workspace/group',
        resume: input.sessionId,
        allowedTools: [
          'Bash',           // Safe - sandboxed in container!
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebSearch', 'WebFetch',
          'mcp__nanoclaw__*',
          'mcp__gmail__*'
        ],
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
        mcpServers: {
          nanoclaw: ipcMcp,
          gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] }
        }
      }
    })) {
      // Capture session ID from init message
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      // Capture final result
      if ('result' in message && message.result) {
        result = message.result as string;
      }
    }

    log('Agent completed successfully');
    writeOutput({
      status: 'success',
      result,
      newSessionId
    });

  } catch (err) {
    log(`Agent error: ${err instanceof Error ? err.message : String(err)}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId,
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  }
}

main();
