/**
 * Hydra Orchestrator API
 *
 * Re-exports the API server and context for integration.
 */

export { createApiServer, stopApiServer, broadcastEvent } from './server.js';
export { createApiContext, appendLog } from './context.js';
export type { Agent, WsEvent } from './server.js';
