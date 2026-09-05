'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot } from 'lucide-react';
import { ChatMessage, TypingIndicator } from '@/components/ai/chat-message';
import { ChatInput } from '@/components/ai/chat-input';
import { QuickActions } from '@/components/ai/quick-actions';
import type { AIChatMessage } from '@/types/ai';

export default function AIAnalyticsPage() {
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, loading, scrollToBottom]);

  const sendMessage = useCallback(async (content: string) => {
    const userMessage: AIChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setLoading(true);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: content }),
      });

      const data = await res.json();

      const assistantMessage: AIChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.error
          ? `**Error:** ${data.error}${data.details ? ` — ${data.details}` : ''}`
          : data.response,
        timestamp: new Date().toISOString(),
        intent: data.intent,
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      const errorMessage: AIChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: '**Error:** Failed to connect to the analytics engine. Please try again.',
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  }, []);

  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col" style={{ height: 'calc(100vh - 80px)' }}>
      {/* Header */}
      <div className="border-b border-white/10 bg-black/40 backdrop-blur-xl px-6 py-4 rounded-t-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-600/20 border border-red-500/30">
            <Bot className="h-5 w-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">Risk Analytics Bot</h1>
            <p className="text-[10px] text-gray-500 uppercase tracking-widest">
              Internal Analytics Engine
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-[10px] text-gray-500">Online</span>
          </div>
        </div>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-4xl space-y-4">
          {isEmpty && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-600/10 border border-red-500/20 mb-6">
                <Bot className="h-8 w-8 text-red-400" />
              </div>
              <h2 className="text-lg font-bold text-white mb-2">
                Risk Analytics Bot
              </h2>
              <p className="text-sm text-gray-500 max-w-md mb-8">
                Review accounts, analyze violations, check risk scores, and generate
                reports. All data is pulled live from your connected trading platforms.
              </p>
              <QuickActions onSelect={sendMessage} disabled={loading} />
            </div>
          )}

          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}

          {loading && <TypingIndicator />}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Quick Actions (shown after first message) */}
      {!isEmpty && !loading && (
        <div className="border-t border-white/5 bg-black/20 px-4 py-2">
          <div className="max-w-4xl mx-auto">
            <QuickActions onSelect={sendMessage} disabled={loading} />
          </div>
        </div>
      )}

      {/* Input */}
      <ChatInput onSend={sendMessage} disabled={loading} />
    </div>
  );
}
