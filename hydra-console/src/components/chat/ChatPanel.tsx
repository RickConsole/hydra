'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useChatStore, useAgentStore } from '@/lib/store';
import { useWebSocket } from '@/hooks/useWebSocket';
import { agentApi } from '@/lib/api';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { Bot } from 'lucide-react';
import type { ChatMessage as ChatMessageType } from '@/types';

export function ChatPanel() {
  const { selectedAgentId, agents } = useAgentStore();
  const { messages, isTyping, addMessage, setTyping } = useChatStore();
  const { subscribe, isConnected } = useWebSocket();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const chatMessages = selectedAgentId ? messages[selectedAgentId] || [] : [];
  const typing = selectedAgentId ? isTyping[selectedAgentId] : false;

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, typing]);

  // Subscribe to WebSocket events
  useEffect(() => {
    if (!selectedAgentId) return;

    const unsubMessage = subscribe('chat:message', (event) => {
      const payload = event.payload as {
        agentId: string;
        message: ChatMessageType;
      };
      if (payload.agentId === selectedAgentId) {
        addMessage(selectedAgentId, {
          ...payload.message,
          timestamp: new Date(payload.message.timestamp),
        });
        // Clear typing indicator when assistant message arrives
        if (payload.message.role === 'assistant') {
          setTyping(selectedAgentId, false);
        }
      }
    });

    const unsubTyping = subscribe('chat:typing', (event) => {
      const payload = event.payload as { agentId: string; typing: boolean };
      if (payload.agentId === selectedAgentId) {
        setTyping(selectedAgentId, payload.typing);
      }
    });

    return () => {
      unsubMessage();
      unsubTyping();
    };
  }, [selectedAgentId, subscribe, addMessage, setTyping]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!selectedAgentId) return;

      // Add user message immediately
      const userMessage: ChatMessageType = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date(),
        agentId: selectedAgentId,
      };
      addMessage(selectedAgentId, userMessage);

      // Show typing indicator
      setTyping(selectedAgentId, true);

      try {
        // Send to API - response comes via WebSocket, so we don't wait for it
        // The API call just triggers the container agent
        await agentApi.sendMessage(selectedAgentId, content);
        // Response will arrive via WebSocket chat:message event
        // Typing indicator will be cleared when response arrives
      } catch (error) {
        // Only show error if it's not a timeout (response may still come via WS)
        const errorMsg = error instanceof Error ? error.message : 'Failed to send message';
        const isTimeout = errorMsg.includes('abort') || errorMsg.includes('timeout');

        if (!isTimeout) {
          // Real error - add error message
          const errorMessage: ChatMessageType = {
            id: crypto.randomUUID(),
            role: 'system',
            content: `Error: ${errorMsg}`,
            timestamp: new Date(),
            agentId: selectedAgentId,
          };
          addMessage(selectedAgentId, errorMessage);
          setTyping(selectedAgentId, false);
        }
        // For timeouts, keep typing indicator - response may still come via WS
      }
    },
    [selectedAgentId, addMessage, setTyping]
  );

  // No agent selected state
  if (!selectedAgentId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-500">
        <Bot size={48} className="mb-4 opacity-50" />
        <p className="text-lg">Select an agent to start chatting</p>
        <p className="text-sm mt-2">
          Use the dropdown in the sidebar to choose an agent
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-zinc-950">
      {/* Agent info bar */}
      <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              selectedAgent?.status === 'running'
                ? 'bg-green-500'
                : selectedAgent?.status === 'error'
                ? 'bg-red-500'
                : 'bg-zinc-500'
            }`}
          />
          <span className="text-sm font-medium text-zinc-300">
            {selectedAgent?.name || selectedAgentId}
          </span>
          <span className="text-xs text-zinc-500">
            {selectedAgent?.platform}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {chatMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-500">
            <p>No messages yet. Say hello!</p>
          </div>
        ) : (
          chatMessages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
        )}

        {/* Typing indicator */}
        {typing && (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center">
              <Bot size={16} className="text-white" />
            </div>
            <div className="bg-zinc-800 rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" />
                <span
                  className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce"
                  style={{ animationDelay: '0.1s' }}
                />
                <span
                  className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce"
                  style={{ animationDelay: '0.2s' }}
                />
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <ChatInput
        onSend={handleSend}
        disabled={!isConnected || selectedAgent?.status !== 'running'}
        placeholder={
          !isConnected
            ? 'Connecting...'
            : selectedAgent?.status !== 'running'
            ? 'Agent is not running'
            : 'Type a message...'
        }
      />
    </div>
  );
}
