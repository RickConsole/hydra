'use client';

import { useEffect, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useConfigStore } from '@/lib/store';
import { configApi } from '@/lib/api';
import { Save, RotateCcw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';

// Dynamic import Monaco to avoid SSR issues
const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

export function ConfigEditor() {
  const {
    config,
    isDirty,
    validationErrors,
    setConfig,
    setValidationErrors,
    resetConfig,
  } = useConfigStore();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Load config on mount
  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    try {
      const response = await configApi.get();
      resetConfig(response.config, response.parsed as import('@/types').HydraConfig);
    } catch (error) {
      console.error('Failed to load config:', error);
      setValidationErrors([
        { path: '', message: `Failed to load config: ${error}` },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    setValidationErrors([]);

    try {
      const result = await configApi.update(config);
      if (result.success) {
        setSaveStatus('success');
        resetConfig(config, null); // Mark as saved
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else if (result.errors) {
        setSaveStatus('error');
        setValidationErrors(result.errors);
      }
    } catch (error) {
      setSaveStatus('error');
      setValidationErrors([
        { path: '', message: `Failed to save: ${error}` },
      ]);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = useCallback(async (content: string) => {
    try {
      const result = await configApi.validate(content);
      if (!result.valid && result.errors) {
        setValidationErrors(result.errors);
      } else {
        setValidationErrors([]);
      }
    } catch {
      // Ignore validation errors during typing
    }
  }, [setValidationErrors]);

  // Debounced validation
  useEffect(() => {
    if (!config) return;
    const timeout = setTimeout(() => {
      handleValidate(config);
    }, 500);
    return () => clearTimeout(timeout);
  }, [config, handleValidate]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <Loader2 className="animate-spin text-zinc-500" size={32} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-zinc-950">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <button
          onClick={handleSave}
          disabled={!isDirty || saving}
          className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors"
        >
          {saving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          Save
        </button>

        <button
          onClick={loadConfig}
          disabled={saving}
          className="flex items-center gap-2 px-3 py-1.5 bg-zinc-700 text-zinc-200 rounded-lg text-sm hover:bg-zinc-600 disabled:opacity-50 transition-colors"
        >
          <RotateCcw size={14} />
          Reload
        </button>

        <div className="flex-1" />

        {/* Status indicator */}
        {saveStatus === 'success' && (
          <div className="flex items-center gap-1 text-green-500 text-sm">
            <CheckCircle size={14} />
            Saved
          </div>
        )}

        {isDirty && saveStatus !== 'success' && (
          <div className="text-yellow-500 text-xs">Unsaved changes</div>
        )}

        {validationErrors.length > 0 && (
          <div className="flex items-center gap-1 text-red-500 text-sm">
            <AlertCircle size={14} />
            {validationErrors.length} error{validationErrors.length > 1 ? 's' : ''}
          </div>
        )}
      </div>

      {/* Validation errors panel */}
      {validationErrors.length > 0 && (
        <div className="border-b border-zinc-800 bg-red-950/30 px-4 py-2 max-h-32 overflow-y-auto">
          {validationErrors.map((error, i) => (
            <div key={i} className="text-sm text-red-400 py-0.5">
              {error.path && (
                <span className="text-red-300 font-mono">{error.path}: </span>
              )}
              {error.message}
            </div>
          ))}
        </div>
      )}

      {/* Editor */}
      <div className="flex-1">
        <Editor
          height="100%"
          defaultLanguage="yaml"
          value={config}
          onChange={(value) => setConfig(value || '')}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}
