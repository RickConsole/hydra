/**
 * Mem0 Memory MCP Server for Hydra
 * Provides persistent memory tools via Mem0.
 *
 * Supports two modes:
 * 1. Cloud mode (MEM0_API_KEY) - Uses mem0's hosted platform
 * 2. Self-hosted mode (QDRANT_URL) - Uses local Qdrant + embeddings
 *
 * Memories are scoped per-group via user_id = groupFolder.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface Mem0McpContext {
  apiKey?: string;         // For cloud mode
  qdrantUrl?: string;      // For self-hosted mode
  embeddingApiKey?: string; // OpenAI/Anthropic key for embeddings (self-hosted)
  groupFolder: string;
}

// Type for mem0 client (cloud or OSS)
interface Mem0Client {
  search(query: string, opts: { user_id: string; limit?: number }): Promise<unknown>;
  add(messages: Array<{ role: string; content: string }>, opts: { user_id: string }): Promise<unknown>;
  getAll(opts: { user_id: string }): Promise<unknown>;
  get(memoryId: string): Promise<unknown>;
  delete(memoryId: string): Promise<unknown>;
}

async function createMem0Client(ctx: Mem0McpContext): Promise<Mem0Client> {
  const { apiKey, qdrantUrl, embeddingApiKey, groupFolder } = ctx;

  // Cloud mode - use MemoryClient
  if (apiKey && !qdrantUrl) {
    const { MemoryClient } = await import('mem0ai');
    console.error('[agent-runner] Mem0 cloud mode enabled');
    return new MemoryClient({ apiKey }) as Mem0Client;
  }

  // Self-hosted mode - use Memory from mem0ai/oss
  if (qdrantUrl) {
    try {
      // Dynamic import for OSS package
      const { Memory } = await import('mem0ai/oss');

      // Parse Qdrant URL
      const url = new URL(qdrantUrl);
      const host = url.hostname;
      const port = parseInt(url.port || '6333', 10);

      console.error(`[agent-runner] Mem0 self-hosted mode enabled (Qdrant: ${host}:${port})`);

      const memory = new Memory({
        vectorStore: {
          provider: 'qdrant',
          config: {
            host,
            port,
            collectionName: 'hydra_memories',
          },
        },
        // Use OpenAI for embeddings if key provided, otherwise use Anthropic
        embedder: embeddingApiKey ? {
          provider: 'openai',
          config: { apiKey: embeddingApiKey },
        } : undefined,
      });

      // Wrap Memory class to match MemoryClient interface
      return {
        search: (query, opts) => memory.search(query, { userId: opts.user_id, limit: opts.limit }),
        add: (messages, opts) => memory.add(messages.map(m => m.content).join('\n'), { userId: opts.user_id }),
        getAll: (opts) => memory.getAll({ userId: opts.user_id }),
        get: (memoryId) => memory.get(memoryId),
        delete: (memoryId) => memory.delete(memoryId),
      };
    } catch (err) {
      console.error('[agent-runner] Failed to initialize mem0 OSS, falling back to disabled:', err);
      throw new Error('Mem0 self-hosted initialization failed. Check Qdrant connection.');
    }
  }

  throw new Error('No mem0 configuration provided. Set MEM0_API_KEY or QDRANT_URL.');
}

export function createMem0Mcp(ctx: Mem0McpContext) {
  const { groupFolder } = ctx;
  let client: Mem0Client | null = null;
  let initError: Error | null = null;

  // Lazy initialization
  const getClient = async (): Promise<Mem0Client> => {
    if (initError) throw initError;
    if (client) return client;

    try {
      client = await createMem0Client(ctx);
      return client;
    } catch (err) {
      initError = err instanceof Error ? err : new Error(String(err));
      throw initError;
    }
  };

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
            const mem0 = await getClient();
            const results = await mem0.search(args.query, {
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
            const mem0 = await getClient();
            const result = await mem0.add(
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
            const mem0 = await getClient();
            const results = await mem0.getAll({ user_id: groupFolder });

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
            const mem0 = await getClient();
            const result = await mem0.get(args.memory_id);

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
            const mem0 = await getClient();
            const result = await mem0.delete(args.memory_id);

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
