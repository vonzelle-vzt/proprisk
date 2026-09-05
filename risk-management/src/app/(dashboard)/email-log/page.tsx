'use client';

import { useState, useEffect, useCallback } from 'react';
import { GlassCard } from '@/components/ui/glass-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Mail, Search, RefreshCw, Loader2, ChevronLeft, ChevronRight, X,
} from 'lucide-react';
import { useAssetClass } from '@/components/layout/provider-context';

interface EmailRecord {
  id: string;
  account_id: string | null;
  challenge_account_id: string | null;
  recipient: string;
  subject: string;
  body: string;
  template_type: string;
  sent_by: string;
  sent_by_name: string | null;
  sent_at: string;
  status: 'sent' | 'failed' | 'pending';
}

interface EmailsResponse {
  data: EmailRecord[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export default function EmailLogPage() {
  const assetClass = useAssetClass();
  const [emails, setEmails] = useState<EmailRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const perPage = 20;

  const fetchEmails = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(perPage),
        assetClass,
      });
      if (search) params.set('search', search);

      const res = await fetch(`/api/emails?${params}`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data: EmailsResponse = await res.json();
      setEmails(data.data);
      setTotal(data.total);
      setTotalPages(data.total_pages);
    } catch {
      setEmails([]);
    } finally {
      setLoading(false);
    }
  }, [page, search, assetClass]);

  useEffect(() => { setEmails([]); setLoading(true); }, [assetClass]);

  useEffect(() => { fetchEmails(); }, [fetchEmails]);

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleReset = () => {
    setSearch('');
    setPage(1);
  };

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Mail className="h-5 w-5 text-red-400" /> Email Log
        </h2>
        <p className="text-sm text-gray-500 mt-1">All violation emails sent to traders</p>
      </div>

      {/* Filters */}
      <GlassCard padding="sm">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-[320px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="Search recipient, subject, account..."
              className="w-full rounded-lg border border-white/10 bg-black/40 pl-8 pr-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:border-red-500/50 focus:outline-none"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={handleReset}>
            <X className="mr-1 h-3 w-3" /> Reset
          </Button>
          <Button variant="secondary" size="sm" onClick={fetchEmails}>
            <RefreshCw className="mr-1 h-3 w-3" /> Refresh
          </Button>
          <span className="ml-auto text-[11px] text-gray-500">{total} email{total !== 1 ? 's' : ''}</span>
        </div>
      </GlassCard>

      {/* Table */}
      <GlassCard padding="none">
        {loading ? (
          <div className="flex items-center justify-center py-12 gap-2 text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-xs">Loading emails...</span>
          </div>
        ) : emails.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-gray-500 text-xs">
            No emails found
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Date</th>
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Recipient</th>
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Subject</th>
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Account</th>
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Sent By</th>
                  <th className="px-3 py-2.5 text-left text-gray-500 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {emails.map((email) => (
                  <>
                    <tr
                      key={email.id}
                      onClick={() => setExpandedId(expandedId === email.id ? null : email.id)}
                      className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                    >
                      <td className="px-3 py-2 text-gray-400 font-mono whitespace-nowrap">{formatDate(email.sent_at)}</td>
                      <td className="px-3 py-2 text-gray-300">{email.recipient}</td>
                      <td className="px-3 py-2 text-gray-400 max-w-[300px] truncate">{email.subject}</td>
                      <td className="px-3 py-2 text-gray-500 font-mono">
                        {email.challenge_account_id || (email.account_id ? email.account_id.slice(0, 8) : '—')}
                      </td>
                      <td className="px-3 py-2 text-gray-500">{email.sent_by_name || email.sent_by}</td>
                      <td className="px-3 py-2">
                        <Badge variant={email.status === 'sent' ? 'green' : email.status === 'failed' ? 'red' : 'yellow'}>
                          {email.status}
                        </Badge>
                      </td>
                    </tr>
                    {expandedId === email.id && (
                      <tr key={`${email.id}-body`} className="border-b border-white/5">
                        <td colSpan={6} className="px-3 py-3">
                          <div className="rounded-lg border border-white/10 bg-black/30 p-1 max-h-[400px] overflow-y-auto">
                            <iframe
                              srcDoc={email.body}
                              className="w-full border-0 rounded"
                              style={{ minHeight: '300px' }}
                              sandbox=""
                              title="Email preview"
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-gray-500">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-1">
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              <ChevronLeft className="h-3 w-3" />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              <ChevronRight className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
