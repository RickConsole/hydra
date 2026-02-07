/**
 * Mem0 Memory MCP Server for NanoClaw
 * Provides persistent memory tools via Mem0's cloud platform API.
 * Memories are scoped per-group via user_id = groupFolder.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { MemoryClient } from 'mem0ai';

export interface Mem0McpContext {
  apiKey: string;
  groupFolder: string;
}

export function createMem0Mcp(ctx: Mem0McpContext) {
  const { apiKey, groupFolder } = ctx;
  const client = new MemoryClient({ apiKey });

  console.error('[agent-runner] Mem0 memory MCP server enabled');

  return createSdkMcpServer({
    name: 'mem0',
    version: '1.0.0',
    tools: [
      tool(
        'memory_search',
        'Search memories by natural language query. Returns relevant memories ranked by similarity.',
        {
          query: z.string().describe('Natural language search query'),
          limit: z.number().optional().default(10).describe('Max results to return (default 10)')
        },
        async (args) => {
          try {
            const results = await client.search(args.query, {
              user_id: groupFolder,
              limit: args.limit
            });

            if (!results || (Array.isArray(results) && results.length === 0)) {
              return {
                content: [{ type: 'text', text: 'No matching memories found.' }]
              };
            }

            return {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Memory search failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true
            };
          }
        }
      ),

      tool(
        'memory_store',
        'Store a new memory. The content will be automatically extracted and deduplicated by Mem0.',
        {
          content: z.string().describe('The memory content to store'),
          role: z.enum(['user', 'assistant']).optional().default('user').describe('Role of the message (default: user)')
        },
        async (args) => {
          try {
            const result = await client.add(
              [{ role: args.role, content: args.content }],
              { user_id: groupFolder }
            );

            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Memory store failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true
            };
          }
        }
      ),

      tool(
        'memory_list',
        'List all memories for this group.',
        {},
        async () => {
          try {
            const results = await client.getAll({ user_id: groupFolder });

            if (!results || (Array.isArray(results) && results.length === 0)) {
              return {
                content: [{ type: 'text', text: 'No memories stored yet.' }]
              };
            }

            return {
              content: [{ type: 'text', text: JSON.stringify(results, null, 2) }]
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Memory list failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true
            };
          }
        }
      ),

      tool(
        'memory_get',
        'Get a specific memory by its ID.',
        {
          memory_id: z.string().describe('The memory ID to retrieve')
        },
        async (args) => {
          try {
            const result = await client.get(args.memory_id);

            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Memory get failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true
            };
          }
        }
      ),

      tool(
        'memory_forget',
        'Delete a memory by its ID.',
        {
          memory_id: z.string().describe('The memory ID to delete')
        },
        async (args) => {
          try {
            const result = await client.delete(args.memory_id);

            return {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
            };
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Memory forget failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true
            };
          }
        }
      )
    ]
  });
}
