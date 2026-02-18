/**
 * Standalone stdio MCP server for mem0 memory in Claude Code CLI sessions.
 * Reads config from env vars, creates mem0 MCP server, connects via stdio transport.
 * Exits cleanly if no memory config is set.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createMem0Mcp, type Mem0McpContext } from './mem0-mcp.js';

const apiKey = process.env.MEM0_API_KEY;
const qdrantUrl = process.env.QDRANT_URL;
const ollamaUrl = process.env.OLLAMA_URL;
const embeddingApiKey = process.env.OPENAI_API_KEY;
const agentFolder = process.env.HYDRA_AGENT_FOLDER || 'unknown';

if (!apiKey && !qdrantUrl) {
  // No memory config — exit cleanly so Claude Code doesn't error
  console.error('[mem0-stdio] No memory configuration (MEM0_API_KEY or QDRANT_URL). Exiting.');
  process.exit(0);
}

// Create the mem0 MCP context
const ctx: Mem0McpContext = {
  apiKey,
  qdrantUrl,
  ollamaUrl,
  embeddingApiKey,
  groupFolder: agentFolder,
};

// We can't use the SDK MCP server directly with stdio transport (it's a different format).
// Instead, create a standard MCP server that wraps the mem0 tools.
// The mem0-mcp.ts createMem0Mcp returns an SDK MCP server, but for CLI we need
// a @modelcontextprotocol/sdk McpServer with stdio transport.

// Lazy-load the mem0 client
let mem0Client: Awaited<ReturnType<typeof createMem0ClientFromCtx>> | null = null;
let initError: Error | null = null;

async function createMem0ClientFromCtx(ctx: Mem0McpContext) {
  const { apiKey, qdrantUrl, ollamaUrl, embeddingApiKey } = ctx;

  if (apiKey && !qdrantUrl) {
    const { MemoryClient } = await import('mem0ai');
    console.error('[mem0-stdio] Mem0 cloud mode enabled');
    return new MemoryClient({ apiKey });
  }

  if (qdrantUrl) {
    const { Memory } = await import('mem0ai/oss');
    const qdrantParsed = new URL(qdrantUrl);
    const qdrantHost = qdrantParsed.hostname;
    const qdrantPort = parseInt(qdrantParsed.port || '6333', 10);

    let embedderConfig;
    if (ollamaUrl) {
      embedderConfig = {
        provider: 'ollama',
        config: { model: 'nomic-embed-text', url: ollamaUrl },
      };
      console.error(`[mem0-stdio] Self-hosted mode (Qdrant: ${qdrantHost}:${qdrantPort}, Ollama: ${ollamaUrl})`);
    } else if (embeddingApiKey) {
      embedderConfig = {
        provider: 'openai',
        config: { apiKey: embeddingApiKey },
      };
      console.error(`[mem0-stdio] Self-hosted mode (Qdrant: ${qdrantHost}:${qdrantPort}, OpenAI embeddings)`);
    } else {
      console.error(`[mem0-stdio] Self-hosted mode (Qdrant: ${qdrantHost}:${qdrantPort}, default embedder)`);
    }

    // LLM config — mem0 uses an LLM to extract/process memories before embedding.
    // Without this it defaults to OpenAI. Use Anthropic Haiku for fast, cheap extraction.
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const llmConfig = anthropicApiKey
      ? { provider: 'anthropic', config: { apiKey: anthropicApiKey, model: 'claude-haiku-4-5-20251001' } }
      : undefined;

    const memory = new Memory({
      vectorStore: {
        provider: 'qdrant',
        config: { host: qdrantHost, port: qdrantPort, collectionName: 'hydra_memories', dimension: 768 },
      },
      embedder: embedderConfig,
      ...(llmConfig ? { llm: llmConfig } : {}),
    });

    // Workaround: mem0's removeCodeBlocks strips entire code blocks (content included).
    // Claude often wraps JSON in ```json ... ```. Wrap the LLM to strip markers before return.
    if ((memory as any).llm) {
      const originalLlm = (memory as any).llm;
      const stripMarkers = (text: string): string =>
        text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      (memory as any).llm = {
        generateResponse: async (...args: unknown[]) => {
          const resp = await originalLlm.generateResponse(...args);
          return typeof resp === 'string' ? stripMarkers(resp) : resp;
        },
        generateChat: originalLlm.generateChat?.bind(originalLlm),
      };
    }

    return {
      search: (query: string, opts: { user_id: string; limit?: number }) =>
        memory.search(query, { userId: opts.user_id, limit: opts.limit }),
      add: (messages: Array<{ role: string; content: string }>, opts: { user_id: string }) =>
        memory.add(messages.map(m => m.content).join('\n'), { userId: opts.user_id }),
      getAll: (opts: { user_id: string }) => memory.getAll({ userId: opts.user_id }),
      get: (memoryId: string) => memory.get(memoryId),
      delete: (memoryId: string) => memory.delete(memoryId),
    };
  }

  throw new Error('No mem0 configuration provided.');
}

async function getClient() {
  if (initError) throw initError;
  if (mem0Client) return mem0Client;
  try {
    mem0Client = await createMem0ClientFromCtx(ctx);
    return mem0Client;
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
    throw initError;
  }
}

const server = new McpServer({
  name: 'mem0',
  version: '1.0.0',
});

server.tool(
  'memory_search',
  'Search memories by natural language query. Returns relevant memories ranked by similarity.',
  {
    query: z.string().describe('Natural language search query'),
    limit: z.number().optional().default(10).describe('Max results to return (default 10)'),
  },
  async (args: { query: string; limit: number }) => {
    try {
      const client = await getClient();
      const results = await client.search(args.query, { user_id: agentFolder, limit: args.limit });
      if (!results || (Array.isArray(results) && results.length === 0)) {
        return { content: [{ type: 'text' as const, text: 'No matching memories found.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_store',
  'Store a new memory. The content will be automatically extracted and deduplicated by Mem0.',
  {
    content: z.string().describe('The memory content to store'),
    role: z.enum(['user', 'assistant']).optional().default('user').describe('Role of the message (default: user)'),
  },
  async (args: { content: string; role: 'user' | 'assistant' }) => {
    try {
      const client = await getClient();
      const result = await client.add([{ role: args.role, content: args.content }], { user_id: agentFolder });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory store failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_list',
  'List all memories for this agent.',
  {},
  async () => {
    try {
      const client = await getClient();
      const results = await client.getAll({ user_id: agentFolder });
      if (!results || (Array.isArray(results) && results.length === 0)) {
        return { content: [{ type: 'text' as const, text: 'No memories stored yet.' }] };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory list failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_get',
  'Get a specific memory by its ID.',
  { memory_id: z.string().describe('The memory ID to retrieve') },
  async (args: { memory_id: string }) => {
    try {
      const client = await getClient();
      const result = await client.get(args.memory_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory get failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_forget',
  'Delete a memory by its ID.',
  { memory_id: z.string().describe('The memory ID to delete') },
  async (args: { memory_id: string }) => {
    try {
      const client = await getClient();
      const result = await client.delete(args.memory_id);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Memory forget failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
