'use client';

import { useUIStore } from '@/lib/store';
import { Menu, RefreshCw } from 'lucide-react';

interface HeaderProps {
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Header({ onRefresh, refreshing }: HeaderProps) {
  const { activeTab, toggleSidebar } = useUIStore();

  const titles: Record<string, string> = {
    chat: 'Chat',
    agents: 'Agents',
    config: 'Configuration',
    memory: 'Memory Browser',
    logs: 'Logs',
  };

  return (
    <header className="h-14 bg-zinc-900 border-b border-zinc-800 flex items-center px-4 gap-4">
      <button
        onClick={toggleSidebar}
        className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
      >
        <Menu size={20} />
      </button>

      <h2 className="text-lg font-semibold text-white">{titles[activeTab]}</h2>

      <div className="flex-1" />

      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors disabled:opacity-50"
        >
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      )}
    </header>
  );
}
