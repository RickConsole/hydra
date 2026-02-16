'use client';

import { useUIStore } from '@/lib/store';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { AgentsPanel } from '@/components/agents/AgentsPanel';
import { ConfigEditor } from '@/components/config/ConfigEditor';
import { MemoryPanel } from '@/components/memory/MemoryPanel';
import { LogsPanel } from '@/components/logs/LogsPanel';

export default function Home() {
  const { activeTab } = useUIStore();

  return (
    <div className="h-screen flex">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <Header />
        {activeTab === 'chat' && <ChatPanel />}
        {activeTab === 'agents' && <AgentsPanel />}
        {activeTab === 'config' && <ConfigEditor />}
        {activeTab === 'memory' && <MemoryPanel />}
        {activeTab === 'logs' && <LogsPanel />}
      </main>
    </div>
  );
}
