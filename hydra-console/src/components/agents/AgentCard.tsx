'use client';

import type { Agent } from '@/types';
import { agentApi } from '@/lib/api';
import { Play, Square, RotateCcw, MessageSquare, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useAgentStore, useUIStore } from '@/lib/store';

interface AgentCardProps {
  agent: Agent;
  onRefresh: () => void;
}

export function AgentCard({ agent, onRefresh }: AgentCardProps) {
  const [loading, setLoading] = useState<'start' | 'stop' | 'restart' | null>(null);
  const { selectAgent } = useAgentStore();
  const { setActiveTab } = useUIStore();

  const statusColors: Record<Agent['status'], string> = {
    running: 'bg-green-500',
    stopped: 'bg-zinc-500',
    error: 'bg-red-500',
    starting: 'bg-yellow-500 animate-pulse',
  };

  const statusLabels: Record<Agent['status'], string> = {
    running: 'Running',
    stopped: 'Stopped',
    error: 'Error',
    starting: 'Starting...',
  };

  const handleAction = async (action: 'start' | 'stop' | 'restart') => {
    setLoading(action);
    try {
      if (action === 'start') await agentApi.start(agent.id);
      else if (action === 'stop') await agentApi.stop(agent.id);
      else await agentApi.restart(agent.id);
      onRefresh();
    } catch (error) {
      console.error(`Failed to ${action} agent:`, error);
    } finally {
      setLoading(null);
    }
  };

  const openChat = () => {
    selectAgent(agent.id);
    setActiveTab('chat');
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-medium text-white">{agent.name}</h3>
          <p className="text-xs text-zinc-500 font-mono">{agent.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${statusColors[agent.status]}`} />
          <span className="text-xs text-zinc-400">{statusLabels[agent.status]}</span>
        </div>
      </div>

      {/* Info */}
      <div className="grid grid-cols-2 gap-2 mb-4 text-sm">
        <div>
          <span className="text-zinc-500">Platform:</span>
          <span className="text-zinc-300 ml-2">{agent.platform}</span>
        </div>
        <div>
          <span className="text-zinc-500">Folder:</span>
          <span className="text-zinc-300 ml-2 font-mono text-xs">{agent.groupFolder}</span>
        </div>
        {agent.uptime !== undefined && (
          <div className="col-span-2">
            <span className="text-zinc-500">Uptime:</span>
            <span className="text-zinc-300 ml-2">{formatUptime(agent.uptime)}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {agent.status === 'running' ? (
          <>
            <button
              onClick={() => handleAction('stop')}
              disabled={loading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 text-red-400 rounded-lg text-sm hover:bg-red-600/30 disabled:opacity-50 transition-colors"
            >
              {loading === 'stop' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Square size={14} />
              )}
              Stop
            </button>
            <button
              onClick={() => handleAction('restart')}
              disabled={loading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 text-zinc-300 rounded-lg text-sm hover:bg-zinc-600 disabled:opacity-50 transition-colors"
            >
              {loading === 'restart' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RotateCcw size={14} />
              )}
              Restart
            </button>
          </>
        ) : (
          <button
            onClick={() => handleAction('start')}
            disabled={loading !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 text-green-400 rounded-lg text-sm hover:bg-green-600/30 disabled:opacity-50 transition-colors"
          >
            {loading === 'start' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            Start
          </button>
        )}

        <div className="flex-1" />

        <button
          onClick={openChat}
          disabled={agent.status !== 'running'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/20 text-blue-400 rounded-lg text-sm hover:bg-blue-600/30 disabled:opacity-50 transition-colors"
        >
          <MessageSquare size={14} />
          Chat
        </button>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
