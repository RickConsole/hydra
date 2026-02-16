/**
 * Hydra Orchestrator API Server
 *
 * Provides HTTP REST + WebSocket endpoints for the Hydra Console to:
 * - Manage agents (list, start, stop, restart)
 * - Edit configuration (get, update, validate)
 * - Chat with agents
 * - Browse memories
 * - Stream logs
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../logger.js';

// Types
export interface Agent {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error' | 'starting';
  platform: string;
  groupFolder: string;
  uptime?: number;
  lastMessage?: string;
}

export interface WsEvent {
  type: string;
  payload: unknown;
  timestamp: string;
}

interface ApiContext {
  getAgents: () => Agent[];
  getConfig: () => { raw: string; parsed: unknown };
  updateConfig: (content: string) => Promise<{ success: boolean; errors?: Array<{ path: string; message: string }> }>;
  validateConfig: (content: string) => { valid: boolean; errors?: Array<{ path: string; message: string }> };
  sendChatMessage: (agentId: string, message: string) => Promise<string>;
  startAgent: (agentId: string) => Promise<void>;
  stopAgent: (agentId: string) => Promise<void>;
  restartAgent: (agentId: string) => Promise<void>;
  getMemories: (agentId: string) => Promise<Array<{ id: string; content: string; createdAt: string }>>;
  searchMemories: (agentId: string, query: string) => Promise<Array<{ id: string; content: string; createdAt: string }>>;
  deleteMemory: (agentId: string, memoryId: string) => Promise<void>;
  getLogs: (agentId?: string, lines?: number) => string[];
}

// Connected WebSocket clients
const wsClients = new Set<WebSocket>();

// Broadcast event to all connected clients
export function broadcastEvent(type: string, payload: unknown): void {
  const event: WsEvent = {
    type,
    payload,
    timestamp: new Date().toISOString(),
  };
  const message = JSON.stringify(event);

  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// Parse JSON body from request
async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Send JSON response
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// Send error response
function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

// Route handler type
type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  ctx: ApiContext
) => Promise<void>;

// Simple router
interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

function addRoute(method: string, path: string, handler: RouteHandler): void {
  // Convert path like /api/agents/:id to regex
  const paramNames: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:(\w+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, pattern, paramNames, handler });
}

function matchRoute(
  method: string,
  path: string
): { handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });
      return { handler: route.handler, params };
    }
  }
  return null;
}

// Define routes
// Health check
addRoute('GET', '/api/health', async (req, res, params, ctx) => {
  sendJson(res, 200, { status: 'ok', version: '1.0.0' });
});

// Config endpoints
addRoute('GET', '/api/config', async (req, res, params, ctx) => {
  const { raw, parsed } = ctx.getConfig();
  sendJson(res, 200, { config: raw, parsed });
});

addRoute('PUT', '/api/config', async (req, res, params, ctx) => {
  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendError(res, 400, 'Missing content field');
    return;
  }
  const result = await ctx.updateConfig(body.content);
  if (result.success) {
    broadcastEvent('config:changed', {});
  }
  sendJson(res, result.success ? 200 : 400, result);
});

addRoute('POST', '/api/config/validate', async (req, res, params, ctx) => {
  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendError(res, 400, 'Missing content field');
    return;
  }
  const result = ctx.validateConfig(body.content);
  sendJson(res, 200, result);
});

// Agent endpoints
addRoute('GET', '/api/agents', async (req, res, params, ctx) => {
  const agents = ctx.getAgents();
  sendJson(res, 200, { agents });
});

addRoute('GET', '/api/agents/:id', async (req, res, params, ctx) => {
  const agents = ctx.getAgents();
  const agent = agents.find((a) => a.id === params.id);
  if (!agent) {
    sendError(res, 404, 'Agent not found');
    return;
  }
  sendJson(res, 200, { agent });
});

addRoute('POST', '/api/agents/:id/start', async (req, res, params, ctx) => {
  try {
    await ctx.startAgent(params.id);
    broadcastEvent('agent:status', { agentId: params.id, status: 'running' });
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Failed to start agent');
  }
});

addRoute('POST', '/api/agents/:id/stop', async (req, res, params, ctx) => {
  try {
    await ctx.stopAgent(params.id);
    broadcastEvent('agent:status', { agentId: params.id, status: 'stopped' });
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Failed to stop agent');
  }
});

addRoute('POST', '/api/agents/:id/restart', async (req, res, params, ctx) => {
  try {
    await ctx.restartAgent(params.id);
    broadcastEvent('agent:status', { agentId: params.id, status: 'running' });
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Failed to restart agent');
  }
});

addRoute('POST', '/api/agents/:id/chat', async (req, res, params, ctx) => {
  const body = (await parseBody(req)) as { message?: string };
  if (!body.message) {
    sendError(res, 400, 'Missing message field');
    return;
  }
  try {
    // Broadcast typing indicator
    broadcastEvent('chat:typing', { agentId: params.id, typing: true });

    const response = await ctx.sendChatMessage(params.id, body.message);

    // Broadcast the response
    broadcastEvent('chat:message', {
      agentId: params.id,
      message: {
        id: `msg-${Date.now()}`,
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
        agentId: params.id,
      },
    });
    broadcastEvent('chat:typing', { agentId: params.id, typing: false });

    sendJson(res, 200, { response });
  } catch (err) {
    broadcastEvent('chat:typing', { agentId: params.id, typing: false });
    sendError(res, 500, err instanceof Error ? err.message : 'Failed to send message');
  }
});

// Memory endpoints
addRoute('GET', '/api/memory/:agentId', async (req, res, params, ctx) => {
  try {
    const memories = await ctx.getMemories(params.agentId);
    sendJson(res, 200, { memories });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Failed to get memories');
  }
});

addRoute('GET', '/api/memory/:agentId/search', async (req, res, params, ctx) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const query = url.searchParams.get('q') || '';
  try {
    const memories = await ctx.searchMemories(params.agentId, query);
    sendJson(res, 200, { memories });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Failed to search memories');
  }
});

addRoute('DELETE', '/api/memory/:agentId/:memoryId', async (req, res, params, ctx) => {
  try {
    await ctx.deleteMemory(params.agentId, params.memoryId);
    sendJson(res, 200, { success: true });
  } catch (err) {
    sendError(res, 500, err instanceof Error ? err.message : 'Failed to delete memory');
  }
});

// Logs endpoint
addRoute('GET', '/api/logs', async (req, res, params, ctx) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const agentId = url.searchParams.get('agent') || undefined;
  const lines = parseInt(url.searchParams.get('lines') || '100', 10);
  const logs = ctx.getLogs(agentId, lines);
  sendJson(res, 200, { logs });
});

// Create and start the API server
export function createApiServer(ctx: ApiContext, port: number = 3340): http.Server {
  const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    logger.debug({ method, path }, 'API request');

    const match = matchRoute(method, path);
    if (match) {
      try {
        await match.handler(req, res, match.params, ctx);
      } catch (err) {
        logger.error({ err, method, path }, 'API handler error');
        sendError(res, 500, 'Internal server error');
      }
    } else {
      sendError(res, 404, 'Not found');
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    logger.info({ clients: wsClients.size }, 'WebSocket client connected');

    ws.on('close', () => {
      wsClients.delete(ws);
      logger.info({ clients: wsClients.size }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
      wsClients.delete(ws);
    });

    // Send welcome event
    ws.send(
      JSON.stringify({
        type: 'system:connected',
        payload: { message: 'Connected to Hydra Orchestrator' },
        timestamp: new Date().toISOString(),
      })
    );
  });

  server.listen(port, () => {
    logger.info({ port }, 'Hydra API server listening');
  });

  return server;
}

export function stopApiServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    // Close all WebSocket connections
    for (const client of wsClients) {
      client.close();
    }
    wsClients.clear();

    server.close(() => {
      logger.info('API server stopped');
      resolve();
    });
  });
}
