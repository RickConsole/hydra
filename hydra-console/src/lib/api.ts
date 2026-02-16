// API client for Hydra Orchestrator

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || 'http://localhost:3340';

interface FetchOptions extends RequestInit {
  timeout?: number;
}

async function fetchWithTimeout(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeout = 10000, ...fetchOptions } = options;

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(id);
  }
}

async function apiRequest<T>(
  endpoint: string,
  options: FetchOptions = {}
): Promise<T> {
  const url = `${ORCHESTRATOR_URL}${endpoint}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Unknown error' }));
    throw new Error(error.message || `API error: ${response.status}`);
  }

  return response.json();
}

// Config endpoints
export const configApi = {
  get: () => apiRequest<{ config: string; parsed: unknown }>('/api/config'),

  update: (content: string) =>
    apiRequest<{ success: boolean; errors?: Array<{ path: string; message: string }> }>(
      '/api/config',
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    ),

  validate: (content: string) =>
    apiRequest<{ valid: boolean; errors?: Array<{ path: string; message: string }> }>(
      '/api/config/validate',
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      }
    ),
};

// Agent endpoints
export const agentApi = {
  list: () => apiRequest<{ agents: Array<import('@/types').Agent> }>('/api/agents'),

  get: (id: string) => apiRequest<{ agent: import('@/types').Agent }>(`/api/agents/${id}`),

  start: (id: string) =>
    apiRequest<{ success: boolean }>(`/api/agents/${id}/start`, { method: 'POST' }),

  stop: (id: string) =>
    apiRequest<{ success: boolean }>(`/api/agents/${id}/stop`, { method: 'POST' }),

  restart: (id: string) =>
    apiRequest<{ success: boolean }>(`/api/agents/${id}/restart`, { method: 'POST' }),

  sendMessage: (id: string, message: string) =>
    apiRequest<{ response: string }>(`/api/agents/${id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
};

// Memory endpoints
export const memoryApi = {
  list: (agentId: string) =>
    apiRequest<{ memories: Array<import('@/types').Memory> }>(`/api/memory/${agentId}`),

  search: (agentId: string, query: string) =>
    apiRequest<{ memories: Array<import('@/types').Memory> }>(
      `/api/memory/${agentId}/search?q=${encodeURIComponent(query)}`
    ),

  delete: (agentId: string, memoryId: string) =>
    apiRequest<{ success: boolean }>(`/api/memory/${agentId}/${memoryId}`, {
      method: 'DELETE',
    }),
};

// System endpoints
export const systemApi = {
  health: () => apiRequest<{ status: string; version: string }>('/api/health'),

  logs: (agentId?: string, lines?: number) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agent', agentId);
    if (lines) params.set('lines', lines.toString());
    return apiRequest<{ logs: string[] }>(`/api/logs?${params}`);
  },
};

export { ORCHESTRATOR_URL };
