'use client';

import type { Agent, AgentStatus } from '@/types';
import { MessageSquare, FileText, Activity, Clock, AlertCircle } from 'lucide-react';
import { useAgentStore, useUIStore } from '@/lib/store';

interface AgentCardProps {
  agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
  const { selectAgent } = useAgentStore();
  const { setActiveTab } = useUIStore();

  const statusConfig: Record<AgentStatus, { color: string; label: string; description: string }> = {
    ready: {
      color: 'bg-green-500',
      label: 'Ready',
      description: 'Waiting for messages',
    },
    processing: {
      color: 'bg-blue-500 animate-pulse',
      label: 'Processing',
      description: 'Handling a request',
    },
    error: {
      color: 'bg-red-500',
      label: 'Error',
      description: agent.lastError || 'Configuration error',
    },
  };

  const status = statusConfig[agent.status];

  const openChat = () => {
    selectAgent(agent.id);
    setActiveTab('chat');
  };

  const openLogs = () => {
    selectAgent(agent.id);
    setActiveTab('logs');
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-medium text-white">{agent.name}</h3>
          <p className="text-xs text-zinc-500">{agent.platform}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${status.color}`} />
          <span className="text-xs text-zinc-400">{status.label}</span>
        </div>
      </div>

      {/* Status description for error state */}
      {agent.status === 'error' && (
        <div className="flex items-start gap-2 mb-3 p-2 bg-red-500/10 rounded-lg">
          <AlertCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-400">{status.description}</p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {/* Last Active */}
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-zinc-500" />
          <div className="text-sm">
            <span className="text-zinc-300">
              {agent.lastActive ? formatRelativeTime(new Date(agent.lastActive)) : 'Never'}
            </span>
          </div>
        </div>

        {/* Active containers */}
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-zinc-500" />
          <div className="text-sm">
            <span className="text-zinc-300">
              {agent.activeContainers || 0} active
            </span>
          </div>
        </div>

        {/* Request stats if available */}
        {agent.stats && (
          <>
            <div className="text-sm">
              <span className="text-zinc-500">Today:</span>
              <span className="text-zinc-300 ml-1">{agent.stats.requestsToday} requests</span>
            </div>
            <div className="text-sm">
              <span className="text-zinc-500">Avg:</span>
              <span className="text-zinc-300 ml-1">{agent.stats.avgResponseTime.toFixed(1)}s</span>
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={openChat}
          disabled={agent.status === 'error'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/20 text-blue-400 rounded-lg text-sm hover:bg-blue-600/30 disabled:opacity-50 transition-colors"
        >
          <MessageSquare size={14} />
          Chat
        </button>

        <button
          onClick={openLogs}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-700 text-zinc-300 rounded-lg text-sm hover:bg-zinc-600 transition-colors"
        >
          <FileText size={14} />
          Logs
        </button>
      </div>
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return date.toLocaleDateString();
}
