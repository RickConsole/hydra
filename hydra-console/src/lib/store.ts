import { create } from 'zustand';
import type { Agent, ChatMessage, HydraConfig } from '@/types';

// Agent store
interface AgentState {
  agents: Agent[];
  selectedAgentId: string | null;
  loading: boolean;
  error: string | null;
  setAgents: (agents: Agent[]) => void;
  selectAgent: (id: string | null) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  selectedAgentId: null,
  loading: false,
  error: null,
  setAgents: (agents) => set({ agents }),
  selectAgent: (id) => set({ selectedAgentId: id }),
  updateAgent: (id, updates) =>
    set((state) => ({
      agents: state.agents.map((agent) =>
        agent.id === id ? { ...agent, ...updates } : agent
      ),
    })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}));

// Chat store
interface ChatState {
  messages: Record<string, ChatMessage[]>; // keyed by agentId
  isTyping: Record<string, boolean>;
  addMessage: (agentId: string, message: ChatMessage) => void;
  setMessages: (agentId: string, messages: ChatMessage[]) => void;
  setTyping: (agentId: string, typing: boolean) => void;
  clearMessages: (agentId: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: {},
  isTyping: {},
  addMessage: (agentId, message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agentId]: [...(state.messages[agentId] || []), message],
      },
    })),
  setMessages: (agentId, messages) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agentId]: messages,
      },
    })),
  setTyping: (agentId, typing) =>
    set((state) => ({
      isTyping: {
        ...state.isTyping,
        [agentId]: typing,
      },
    })),
  clearMessages: (agentId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [agentId]: [],
      },
    })),
}));

// Config store
interface ConfigState {
  config: string; // Raw YAML content
  parsed: HydraConfig | null;
  isDirty: boolean;
  validationErrors: Array<{ path: string; message: string }>;
  setConfig: (config: string) => void;
  setParsed: (parsed: HydraConfig | null) => void;
  setDirty: (dirty: boolean) => void;
  setValidationErrors: (errors: Array<{ path: string; message: string }>) => void;
  resetConfig: (config: string, parsed: HydraConfig | null) => void;
}

export const useConfigStore = create<ConfigState>((set) => ({
  config: '',
  parsed: null,
  isDirty: false,
  validationErrors: [],
  setConfig: (config) => set({ config, isDirty: true }),
  setParsed: (parsed) => set({ parsed }),
  setDirty: (isDirty) => set({ isDirty }),
  setValidationErrors: (validationErrors) => set({ validationErrors }),
  resetConfig: (config, parsed) =>
    set({ config, parsed, isDirty: false, validationErrors: [] }),
}));

// UI store
interface UIState {
  activeTab: 'chat' | 'agents' | 'config' | 'memory' | 'logs';
  sidebarOpen: boolean;
  setActiveTab: (tab: UIState['activeTab']) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: 'chat',
  sidebarOpen: true,
  setActiveTab: (activeTab) => set({ activeTab }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
