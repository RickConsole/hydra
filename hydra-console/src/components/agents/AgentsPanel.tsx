'use client';

import { useEffect, useCallback } from 'react';
import { useAgentStore } from '@/lib/store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { agentApi } from '@/lib/api';
import { AgentCard } from './AgentCard';
import { Bot, Loader2 } from 'lucide-react';

export function AgentsPanel() {
  const { agents, loading, error, setAgents, setLoading, setError, updateAgent } =
    useAgentStore();
  const { subscribe } = useWebSocket();

  const loadAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await agentApi.list();
      setAgents(response.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, [setAgents, setLoading, setError]);

  // Load agents on mount
  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Subscribe to agent status updates
  useEffect(() => {
    const unsubscribe = subscribe('agent:status', (event) => {
      const payload = event.payload as {
        agentId: string;
        status: import('@/types').Agent['status'];
      };
      updateAgent(payload.agentId, { status: payload.status });
    });

    return unsubscribe;
  }, [subscribe, updateAgent]);

  if (loading && agents.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <Loader2 className="animate-spin text-zinc-500" size={32} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 text-zinc-500">
        <p className="text-red-400 mb-4">{error}</p>
        <button
          onClick={loadAgents}
          className="px-4 py-2 bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 text-zinc-500">
        <Bot size={48} className="mb-4 opacity-50" />
        <p className="text-lg">No agents configured</p>
        <p className="text-sm mt-2">Add agents in the Config tab</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950 p-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 max-w-6xl mx-auto">
        {agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} onRefresh={loadAgents} />
        ))}
      </div>
    </div>
  );
}
