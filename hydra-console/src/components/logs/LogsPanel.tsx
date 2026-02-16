'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAgentStore } from '@/lib/store';
import { systemApi } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';
import { FileText, Loader2, Trash2 } from 'lucide-react';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  agentId?: string;
}

export function LogsPanel() {
  const { agents } = useAgentStore();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const { subscribe } = useWebSocket();

  // Load initial logs
  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const agentId = filter === 'all' ? undefined : filter;
      const response = await systemApi.logs(agentId, 200);
      const parsed = response.logs.map(parseLine);
      setLogs(parsed);
    } catch (error) {
      console.error('Failed to load logs:', error);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // Subscribe to real-time log events
  useEffect(() => {
    const unsubscribe = subscribe('system:error', (event) => {
      const payload = event.payload as { message: string; agentId?: string };
      setLogs((prev) => [
        ...prev,
        {
          timestamp: new Date().toISOString(),
          level: 'error',
          message: payload.message,
          agentId: payload.agentId,
        },
      ]);
    });

    return unsubscribe;
  }, [subscribe]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const clearLogs = () => setLogs([]);

  const filteredLogs = filter === 'all'
    ? logs
    : logs.filter((log) => log.agentId === filter || !log.agentId);

  const levelColors: Record<string, string> = {
    info: 'text-blue-400',
    warn: 'text-yellow-400',
    error: 'text-red-400',
    debug: 'text-zinc-500',
  };

  return (
    <div className="flex-1 flex flex-col bg-zinc-950">
      {/* Toolbar */}
      <div className="flex items-center gap-4 p-4 border-b border-zinc-800">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          <option value="all">All logs</option>
          <option value="system">System only</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded border-zinc-600 bg-zinc-800 text-blue-600 focus:ring-blue-500 focus:ring-offset-zinc-900"
          />
          Auto-scroll
        </label>

        <div className="flex-1" />

        <button
          onClick={clearLogs}
          className="flex items-center gap-1.5 px-3 py-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg text-sm transition-colors"
        >
          <Trash2 size={14} />
          Clear
        </button>
      </div>

      {/* Logs */}
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="animate-spin text-zinc-500" size={32} />
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
            <FileText size={32} className="mb-3 opacity-50" />
            <p>No logs to display</p>
          </div>
        ) : (
          <div className="p-4">
            {filteredLogs.map((log, i) => (
              <div
                key={i}
                className="flex gap-2 py-0.5 hover:bg-zinc-900/50 px-2 -mx-2 rounded"
              >
                <span className="text-zinc-600 shrink-0">
                  {formatTimestamp(log.timestamp)}
                </span>
                <span className={`shrink-0 w-12 ${levelColors[log.level]}`}>
                  [{log.level.toUpperCase()}]
                </span>
                {log.agentId && (
                  <span className="text-zinc-500 shrink-0">
                    [{log.agentId.slice(0, 8)}]
                  </span>
                )}
                <span className="text-zinc-300 break-all">{log.message}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>
    </div>
  );
}

function parseLine(line: string): LogEntry {
  // Try to parse structured log format: [timestamp] [level] message
  const match = line.match(/^\[([^\]]+)\]\s*\[(\w+)\]\s*(.*)$/);
  if (match) {
    return {
      timestamp: match[1],
      level: match[2].toLowerCase() as LogEntry['level'],
      message: match[3],
    };
  }

  // Fallback to raw line
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    message: line,
  };
}

function formatTimestamp(ts: string): string {
  try {
    const date = new Date(ts);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts.slice(11, 19); // Fallback: just extract HH:MM:SS
  }
}
