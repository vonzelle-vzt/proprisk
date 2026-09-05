'use client';

import Markdown from 'react-markdown';
import { cn } from '@/lib/utils/cn';
import type { AIChatMessage } from '@/types/ai';

interface ChatMessageProps {
  message: AIChatMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex w-full', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'rounded-2xl',
          isUser
            ? 'max-w-[85%] bg-red-600/30 border border-red-500/30 text-white px-4 py-3'
            : 'w-full max-w-[95%] bg-white/[0.03] border border-white/10 text-gray-200 px-5 py-4'
        )}
      >
        {isUser ? (
          <p className="text-sm">{message.content}</p>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <Markdown
              components={{
                table: ({ children }) => (
                  <div className="overflow-x-auto my-3 rounded-lg border border-white/10">
                    <table className="min-w-full text-xs border-collapse">
                      {children}
                    </table>
                  </div>
                ),
                thead: ({ children }) => (
                  <thead className="bg-white/5 border-b border-white/15">{children}</thead>
                ),
                th: ({ children }) => (
                  <th className="px-3 py-2 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                    {children}
                  </th>
                ),
                td: ({ children }) => (
                  <td className="px-3 py-2 text-gray-300 text-xs whitespace-nowrap border-b border-white/5">{children}</td>
                ),
                tr: ({ children }) => (
                  <tr className="hover:bg-white/[0.03] transition-colors">{children}</tr>
                ),
                h2: ({ children }) => (
                  <h2 className="text-base font-bold text-white mt-0 mb-3 pb-2 border-b border-white/10">{children}</h2>
                ),
                h3: ({ children }) => (
                  <h3 className="text-sm font-semibold text-gray-200 mt-4 mb-2 flex items-center gap-1.5">
                    <span className="w-1 h-4 bg-red-500 rounded-full inline-block" />
                    {children}
                  </h3>
                ),
                strong: ({ children }) => (
                  <strong className="text-white font-semibold">{children}</strong>
                ),
                em: ({ children }) => (
                  <em className="text-gray-400 not-italic text-xs">{children}</em>
                ),
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-red-500 bg-red-500/5 rounded-r-lg pl-3 pr-3 py-2 my-3 text-red-300">
                    {children}
                  </blockquote>
                ),
                code: ({ children, className }) => {
                  const isBlock = className?.includes('language-');
                  if (isBlock) {
                    return (
                      <code className="block bg-black/40 rounded-lg p-3 text-xs font-mono text-gray-300 overflow-x-auto border border-white/10">
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code className="bg-white/10 rounded px-1.5 py-0.5 text-xs font-mono text-red-300">
                      {children}
                    </code>
                  );
                },
                hr: () => (
                  <hr className="border-white/10 my-4" />
                ),
                ul: ({ children }) => (
                  <ul className="list-none space-y-1 text-sm my-2">{children}</ul>
                ),
                li: ({ children }) => (
                  <li className="text-gray-300 flex items-start gap-2">
                    <span className="text-red-400 mt-1.5 shrink-0 text-[6px]">&#9679;</span>
                    <span>{children}</span>
                  </li>
                ),
                p: ({ children }) => (
                  <p className="text-sm leading-relaxed my-1.5">{children}</p>
                ),
              }}
            >
              {message.content}
            </Markdown>
          </div>
        )}
        <p className="mt-2 text-[10px] text-gray-600">
          {new Date(message.timestamp).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
          })}
          {message.intent && message.intent !== 'unknown' && message.intent !== 'general_question' && (
            <span className="ml-2 text-gray-600/70">{message.intent.replace(/_/g, ' ')}</span>
          )}
        </p>
      </div>
    </div>
  );
}

export function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-red-400 animate-bounce [animation-delay:-0.3s]" />
          <div className="h-2 w-2 rounded-full bg-red-400 animate-bounce [animation-delay:-0.15s]" />
          <div className="h-2 w-2 rounded-full bg-red-400 animate-bounce" />
          <span className="ml-2 text-xs text-gray-500">Analyzing...</span>
        </div>
      </div>
    </div>
  );
}
