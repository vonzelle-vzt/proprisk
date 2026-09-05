'use client';

import { useEffect, useState } from 'react';
import { LifeBuoy, X } from 'lucide-react';
import { GlassCard } from '@/components/ui/glass-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

type TicketSeverity = 'low' | 'normal' | 'high' | 'urgent';
type TicketStatus = 'open' | 'in_progress' | 'resolved';

interface Ticket {
  id: string;
  subject: string;
  severity: TicketSeverity;
  status: TicketStatus;
  createdAt: string;
}

const STATUS_BADGE: Record<TicketStatus, 'yellow' | 'blue' | 'green'> = {
  open: 'yellow',
  in_progress: 'blue',
  resolved: 'green',
};

/**
 * The "don't babysit me" surface: a firm hitting a wall files a ticket here
 * instead of emailing the configured support inbox directly and re-explaining
 * their setup. Diagnostics are attached server-side (src/lib/support/tickets.ts)
 * — this widget only collects what the firm actually knows: what happened.
 */
export function GetHelpWidget() {
  const [open, setOpen] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<TicketSeverity>('normal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    fetch('/api/support/tickets')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((payload) => setTickets(payload.data ?? []))
      .catch(() => setTickets([]));
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    const res = await fetch('/api/support/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, body, severity }),
    });
    const payload = await res.json().catch(() => ({}));

    if (!res.ok) {
      setError(payload.error ?? 'Failed to send ticket');
      setSubmitting(false);
      return;
    }

    setTickets((prev) => [payload.data, ...prev]);
    setSubject('');
    setBody('');
    setSeverity('normal');
    setSubmitting(false);
    setSubmitted(true);
    setTimeout(() => setSubmitted(false), 3000);
  };

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {open ? (
        <GlassCard padding="md" className="w-80 shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-white">Get help</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-gray-400 hover:text-white"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30"
              required
              maxLength={200}
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What's going wrong?"
              rows={4}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30 resize-none"
              required
              maxLength={5000}
            />
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as TicketSeverity)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-gray-200 outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
            {error ? (
              <p className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-[10px] text-red-300">
                {error}
              </p>
            ) : null}
            {submitted ? (
              <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[10px] text-emerald-300">
                Ticket sent — we&apos;ll follow up by email.
              </p>
            ) : null}
            <Button type="submit" size="sm" loading={submitting} className="w-full">
              Send
            </Button>
          </form>

          {tickets.length > 0 ? (
            <div className="mt-4 pt-3 border-t border-white/10 space-y-2 max-h-40 overflow-y-auto">
              <p className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                Your tickets
              </p>
              {tickets.map((ticket) => (
                <div key={ticket.id} className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-gray-300 truncate">{ticket.subject}</span>
                  <Badge variant={STATUS_BADGE[ticket.status]}>{ticket.status}</Badge>
                </div>
              ))}
            </div>
          ) : null}
        </GlassCard>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 bg-red-600 hover:bg-red-700 text-white text-xs font-medium px-4 py-2.5 rounded-xl shadow-lg shadow-red-500/20 hover:shadow-red-500/40 transition-all focus:outline-none focus:ring-2 focus:ring-red-500/50 focus:ring-offset-2 focus:ring-offset-[#0a0a0a]"
        >
          <LifeBuoy className="h-4 w-4" />
          Get help
        </button>
      )}
    </div>
  );
}
