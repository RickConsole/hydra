'use client';

import type { ChatMessage as ChatMessageType } from '@/types';
import { Bot, User } from 'lucide-react';

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isAssistant = message.role === 'assistant';
  const isSystem = message.role === 'system';

  return (
    <div
      className={`flex gap-3 ${isAssistant ? 'flex-row' : 'flex-row-reverse'} ${
        isSystem ? 'opacity-60' : ''
      }`}
    >
      {/* Avatar */}
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
          isAssistant
            ? 'bg-blue-600'
            : isSystem
            ? 'bg-zinc-600'
            : 'bg-green-600'
        }`}
      >
        {isAssistant ? (
          <Bot size={16} className="text-white" />
        ) : (
          <User size={16} className="text-white" />
        )}
      </div>

      {/* Message bubble */}
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2 ${
          isAssistant
            ? 'bg-zinc-800 text-zinc-100 rounded-tl-sm'
            : isSystem
            ? 'bg-zinc-700 text-zinc-300 rounded-tr-sm'
            : 'bg-blue-600 text-white rounded-tr-sm'
        }`}
      >
        {/* Render markdown-ish content */}
        <div className="text-sm whitespace-pre-wrap break-words prose prose-invert prose-sm max-w-none">
          {renderContent(message.content)}
        </div>

        {/* Timestamp */}
        <div
          className={`text-[10px] mt-1 ${
            isAssistant ? 'text-zinc-500' : 'text-blue-200'
          }`}
        >
          {formatTime(message.timestamp)}
        </div>
      </div>
    </div>
  );
}

function renderContent(content: string) {
  // Basic code block handling
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, i) => {
    if (part.startsWith('```')) {
      const match = part.match(/```(\w+)?\n?([\s\S]*?)```/);
      if (match) {
        const [, lang, code] = match;
        return (
          <pre
            key={i}
            className="bg-zinc-900 rounded-lg p-3 my-2 overflow-x-auto text-xs"
          >
            {lang && (
              <div className="text-zinc-500 text-[10px] mb-2 uppercase">
                {lang}
              </div>
            )}
            <code>{code.trim()}</code>
          </pre>
        );
      }
    }

    // Inline code
    const inlineCode = part.split(/(`[^`]+`)/g);
    return inlineCode.map((segment, j) => {
      if (segment.startsWith('`') && segment.endsWith('`')) {
        return (
          <code
            key={`${i}-${j}`}
            className="bg-zinc-700 px-1.5 py-0.5 rounded text-xs"
          >
            {segment.slice(1, -1)}
          </code>
        );
      }
      return <span key={`${i}-${j}`}>{segment}</span>;
    });
  });
}

function formatTime(date: Date): string {
  return new Date(date).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
