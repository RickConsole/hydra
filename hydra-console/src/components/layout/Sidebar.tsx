'use client';

import { useUIStore, useAgentStore } from '@/lib/store';
import { MessageSquare, Bot, Settings, Brain, FileText } from 'lucide-react';

const navItems = [
  { id: 'chat' as const, label: 'Chat', icon: MessageSquare },
  { id: 'agents' as const, label: 'Agents', icon: Bot },
  { id: 'config' as const, label: 'Config', icon: Settings },
  { id: 'memory' as const, label: 'Memory', icon: Brain },
  { id: 'logs' as const, label: 'Logs', icon: FileText },
];

export function Sidebar() {
  const { activeTab, setActiveTab, sidebarOpen } = useUIStore();
  const { agents, selectedAgentId, selectAgent } = useAgentStore();

  if (!sidebarOpen) return null;

  return (
    <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col">
      {/* Logo */}
      <div className="p-4 border-b border-zinc-800">
        <h1 className="text-xl font-bold text-white flex items-center gap-2">
          <span className="text-2xl">🐉</span>
          Hydra Console
        </h1>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-2">
        <ul className="space-y-1">
          {navItems.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                onClick={() => setActiveTab(id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeTab === id
                    ? 'bg-blue-600 text-white'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                <Icon size={18} />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {/* Agent selector (for chat/memory tabs) */}
      {(activeTab === 'chat' || activeTab === 'memory') && agents.length > 0 && (
        <div className="p-4 border-t border-zinc-800">
          <label className="text-xs text-zinc-500 uppercase tracking-wider mb-2 block">
            Active Agent
          </label>
          <select
            value={selectedAgentId || ''}
            onChange={(e) => selectAgent(e.target.value || null)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">Select an agent...</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Connection status */}
      <div className="p-4 border-t border-zinc-800">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-green-500"></span>
          Connected to Orchestrator
        </div>
      </div>
    </aside>
  );
}
