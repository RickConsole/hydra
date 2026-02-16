'use client';

import { useEffect, useState, useCallback } from 'react';
import { taskApi } from '@/lib/api';
import type { ScheduledTask, TaskStatus, ScheduleType } from '@/types';
import {
  Calendar,
  Clock,
  Pause,
  Play,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle,
  RefreshCw,
} from 'lucide-react';

export function TasksPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const response = await taskApi.list();
      setTasks(response.tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
    // Refresh every 30 seconds
    const interval = setInterval(loadTasks, 30000);
    return () => clearInterval(interval);
  }, [loadTasks]);

  const handlePause = async (taskId: string) => {
    setActionLoading(taskId);
    try {
      await taskApi.pause(taskId);
      await loadTasks();
    } catch (err) {
      console.error('Failed to pause task:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleResume = async (taskId: string) => {
    setActionLoading(taskId);
    try {
      await taskApi.resume(taskId);
      await loadTasks();
    } catch (err) {
      console.error('Failed to resume task:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancel = async (taskId: string) => {
    if (!confirm('Are you sure you want to delete this task?')) return;
    setActionLoading(taskId);
    try {
      await taskApi.cancel(taskId);
      await loadTasks();
    } catch (err) {
      console.error('Failed to cancel task:', err);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
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
          onClick={loadTasks}
          className="px-4 py-2 bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 text-zinc-500">
        <Calendar size={48} className="mb-4 opacity-50" />
        <p className="text-lg">No scheduled tasks</p>
        <p className="text-sm mt-2">Tasks created via chat will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-zinc-950 p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-white">Scheduled Tasks</h2>
          <button
            onClick={loadTasks}
            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 text-zinc-300 rounded-lg hover:bg-zinc-700 transition-colors text-sm"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>

        {/* Task list */}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            isLoading={actionLoading === task.id}
            onPause={() => handlePause(task.id)}
            onResume={() => handleResume(task.id)}
            onCancel={() => handleCancel(task.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface TaskCardProps {
  task: ScheduledTask;
  isLoading: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

function TaskCard({ task, isLoading, onPause, onResume, onCancel }: TaskCardProps) {
  const statusConfig: Record<TaskStatus, { color: string; icon: typeof CheckCircle }> = {
    active: { color: 'text-green-400', icon: CheckCircle },
    paused: { color: 'text-yellow-400', icon: Pause },
    completed: { color: 'text-zinc-400', icon: CheckCircle },
    failed: { color: 'text-red-400', icon: AlertCircle },
  };

  const status = statusConfig[task.status];
  const StatusIcon = status.icon;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <StatusIcon size={14} className={status.color} />
            <span className={`text-xs font-medium ${status.color}`}>
              {task.status.charAt(0).toUpperCase() + task.status.slice(1)}
            </span>
          </div>
          <p className="text-sm text-zinc-300 line-clamp-2">{task.prompt}</p>
        </div>
      </div>

      {/* Schedule info */}
      <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-zinc-500" />
          <span className="text-zinc-400">{formatSchedule(task.scheduleType, task.scheduleValue)}</span>
        </div>

        {task.nextRun && task.status === 'active' && (
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-zinc-500" />
            <span className="text-zinc-400">
              Next: {formatRelativeTime(new Date(task.nextRun))}
            </span>
          </div>
        )}

        {task.lastRun && (
          <div className="flex items-center gap-2 col-span-2">
            <span className="text-zinc-500">Last run:</span>
            <span className={task.lastRunStatus === 'error' ? 'text-red-400' : 'text-zinc-400'}>
              {formatRelativeTime(new Date(task.lastRun))}
              {task.lastRunStatus === 'error' && task.lastError && (
                <span className="ml-2 text-red-400">({task.lastError})</span>
              )}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        {task.status === 'active' ? (
          <button
            onClick={onPause}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600/20 text-yellow-400 rounded-lg text-sm hover:bg-yellow-600/30 disabled:opacity-50 transition-colors"
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
            Pause
          </button>
        ) : task.status === 'paused' ? (
          <button
            onClick={onResume}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600/20 text-green-400 rounded-lg text-sm hover:bg-green-600/30 disabled:opacity-50 transition-colors"
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Resume
          </button>
        ) : null}

        <button
          onClick={onCancel}
          disabled={isLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 text-red-400 rounded-lg text-sm hover:bg-red-600/30 disabled:opacity-50 transition-colors"
        >
          {isLoading ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          Delete
        </button>
      </div>
    </div>
  );
}

function formatSchedule(type: ScheduleType, value: string): string {
  switch (type) {
    case 'cron':
      return `Cron: ${value}`;
    case 'interval':
      const ms = parseInt(value, 10);
      if (ms < 60000) return `Every ${Math.round(ms / 1000)}s`;
      if (ms < 3600000) return `Every ${Math.round(ms / 60000)}m`;
      return `Every ${Math.round(ms / 3600000)}h`;
    case 'once':
      return `Once: ${new Date(value).toLocaleString()}`;
    default:
      return value;
  }
}

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiffMs = Math.abs(diffMs);
  const isPast = diffMs < 0;

  const diffSec = Math.floor(absDiffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  let timeStr: string;
  if (diffSec < 60) timeStr = 'less than a minute';
  else if (diffMin < 60) timeStr = `${diffMin}m`;
  else if (diffHour < 24) timeStr = `${diffHour}h`;
  else timeStr = `${diffDay}d`;

  return isPast ? `${timeStr} ago` : `in ${timeStr}`;
}
