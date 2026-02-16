'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAgentStore } from '@/lib/store';
import { memoryApi } from '@/lib/api';
import type { Memory } from '@/types';
import { Search, Trash2, Brain, Loader2 } from 'lucide-react';

export function MemoryPanel() {
  const { selectedAgentId, agents } = useAgentStore();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  const loadMemories = useCallback(async () => {
    if (!selectedAgentId) return;

    setLoading(true);
    try {
      const response = await memoryApi.list(selectedAgentId);
      setMemories(response.memories);
    } catch (error) {
      console.error('Failed to load memories:', error);
    } finally {
      setLoading(false);
    }
  }, [selectedAgentId]);

  const handleSearch = async () => {
    if (!selectedAgentId || !searchQuery.trim()) {
      loadMemories();
      return;
    }

    setSearching(true);
    try {
      const response = await memoryApi.search(selectedAgentId, searchQuery);
      setMemories(response.memories);
    } catch (error) {
      console.error('Failed to search memories:', error);
    } finally {
      setSearching(false);
    }
  };

  const handleDelete = async (memoryId: string) => {
    if (!selectedAgentId) return;
    if (!confirm('Are you sure you want to delete this memory?')) return;

    try {
      await memoryApi.delete(selectedAgentId, memoryId);
      setMemories((prev) => prev.filter((m) => m.id !== memoryId));
    } catch (error) {
      console.error('Failed to delete memory:', error);
    }
  };

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  // No agent selected
  if (!selectedAgentId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 text-zinc-500">
        <Brain size={48} className="mb-4 opacity-50" />
        <p className="text-lg">Select an agent to browse memories</p>
        <p className="text-sm mt-2">
          Use the dropdown in the sidebar to choose an agent
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-zinc-950">
      {/* Search bar */}
      <div className="p-4 border-b border-zinc-800">
        <div className="flex gap-2 max-w-2xl">
          <div className="flex-1 relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="Search memories..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={handleSearch}
            disabled={searching}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {searching ? <Loader2 size={16} className="animate-spin" /> : 'Search'}
          </button>
        </div>

        <div className="mt-2 text-xs text-zinc-500">
          Browsing memories for{' '}
          <span className="text-zinc-300">{selectedAgent?.name || selectedAgentId}</span>
        </div>
      </div>

      {/* Memory list */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-zinc-500" size={32} />
          </div>
        ) : memories.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <Brain size={32} className="mx-auto mb-3 opacity-50" />
            <p>No memories found</p>
          </div>
        ) : (
          <div className="space-y-3 max-w-4xl mx-auto">
            {memories.map((memory) => (
              <div
                key={memory.id}
                className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 group"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200 whitespace-pre-wrap">
                      {memory.content}
                    </p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
                      <span className="font-mono">{memory.id.slice(0, 8)}...</span>
                      <span>{formatDate(memory.createdAt)}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(memory.id)}
                    className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-900/20 rounded-lg opacity-0 group-hover:opacity-100 transition-all"
                    title="Delete memory"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
