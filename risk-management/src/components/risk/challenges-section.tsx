'use client';

import { useState, Fragment } from 'react';
import {
  AlertTriangle, TrendingDown, Activity, RefreshCw, Users, Ban, Mail, ChevronDown, ChevronRight, Search, Loader2,
} from 'lucide-react';
import { SendViolationEmailModal } from '@/components/challenges/send-violation-email-modal';
import { GlassCard } from '@/components/ui/glass-card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usePassedChallenges, type PassedChallengeAccount, type AnalysisResult } from '@/hooks/use-challenge-dashboard';
import { parsePlanName } from '@/lib/platform/plan-name';
import { formatCurrency } from '@/lib/utils/format';
import { ViolationBreakdownCard } from './violation-breakdown-card';

// --- Expanded Row Detail ---
function ExpandedAnalysis({ result, account, onRevalidate, revalidating }: { result: AnalysisResult; account: PassedChallengeAccount; onRevalidate: () => void; revalidating: boolean }) {
  const [sendEmailOpen, setSendEmailOpen] = useState(false);

  const VIOLATION_LABELS: Record<string, string> = {
    overleveraging: 'Overleveraging', hft: 'HFT', martingale: 'Martingale',
    news: 'News Trading', grid: 'Grid Trading', copy: 'Copy Trading',
    overnight: 'Overnight',
  };

  const SEVERITY_BADGE_MAP: Record<string, 'red' | 'yellow' | 'blue' | 'silver'> = {
    critical: 'red', high: 'yellow', medium: 'blue', low: 'silver',
  };

  // Build a map of trade ID → violation type keys for highlighting
  const buildViolationMap = (data: AnalysisResult['phase2']) => {
    const map = new Map<string, string[]>();
    if (!data?.violation_details) return map;
    for (const [typeKey, details] of Object.entries(data.violation_details)) {
      for (const d of details) {
        const existing = map.get(d.trade_id) || [];
        if (!existing.includes(typeKey)) existing.push(typeKey);
        map.set(d.trade_id, existing);
      }
    }
    return map;
  };

  const renderPhaseSummary = (data: AnalysisResult['phase2'], label: string, login?: number | string) => {
    if (!data) return null;
    const pnl = data.balance - data.starting_balance;
    const pnlPct = data.starting_balance > 0 ? (pnl / data.starting_balance) * 100 : 0;

    return (
      <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-gray-300">
            {label}{login ? ` (Login: ${login})` : ''}
          </span>
          <Badge variant={SEVERITY_BADGE_MAP[data.severity] || 'silver'} className="!text-[9px]">
            {data.severity}
          </Badge>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[10px]">
          <div>
            <span className="text-gray-600">Starting</span>
            <div className="text-gray-300 font-medium">{formatCurrency(data.starting_balance)}</div>
          </div>
          <div>
            <span className="text-gray-600">Final Balance</span>
            <div className="text-gray-300 font-medium">{formatCurrency(data.balance)}</div>
          </div>
          <div>
            <span className="text-gray-600">P&L</span>
            <div className={pnl >= 0 ? 'text-green-400 font-medium' : 'text-red-400 font-medium'}>
              {formatCurrency(pnl)} ({pnlPct.toFixed(1)}%)
            </div>
          </div>
          <div>
            <span className="text-gray-600">Traded Days</span>
            <div className="text-gray-300 font-medium">{data.traded_days}</div>
          </div>
        </div>
        {data.pass_date && (
          <div className="text-[10px] text-gray-500">
            Passed: {new Date(data.pass_date).toLocaleDateString()}
          </div>
        )}
        <div className="text-[10px] text-gray-500">
          {data.violation_count > 0
            ? `${data.violation_types.length} violation type(s), ${formatCurrency(data.total_deductions)} total deductions`
            : 'No violations detected'}
        </div>
      </div>
    );
  };

  const renderPhaseViolations = (data: AnalysisResult['phase2'], label: string) => {
    if (!data) return null;
    const breakdown = data.deduction_breakdown || {};
    const details = data.violation_details || {};
    const types = Object.entries(breakdown).filter(([, amt]) => amt > 0);

    if (types.length === 0) return null;

    return (
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-gray-300">{label} Violations — {formatCurrency(data.total_deductions)}</div>
        {types.map(([type, amount]) => {
          const tradeDetails = details[type] || [];
          return (
            <div key={type} className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-200">{VIOLATION_LABELS[type] || type}</span>
                <span className="text-xs font-semibold text-red-400">{formatCurrency(amount)}</span>
              </div>
              {tradeDetails.length > 0 && (
                <div className="mt-2 space-y-1 max-h-[120px] overflow-y-auto">
                  {tradeDetails.map((td: { trade_id: string; explanation: string; amount: number }, i: number) => (
                    <div key={i} className="flex items-start gap-2 text-[10px]">
                      <span className="text-gray-600 shrink-0 font-mono">{td.trade_id}</span>
                      <span className="text-gray-400 flex-1">{td.explanation}</span>
                      <span className="text-red-400 shrink-0">{formatCurrency(td.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderPhaseNewsEvents = (data: AnalysisResult['phase2'], label: string) => {
    if (!data?.news_events || data.news_events.length === 0) return null;
    // Build set of news event titles that triggered violations
    const violationNews = new Set<string>();
    if (data.violation_details?.news) {
      for (const v of data.violation_details.news) {
        // Extract event title from explanation: `Trade opened/closed Xmin from "EVENT TITLE" (COUNTRY, High)`
        const match = v.explanation.match(/"([^"]+)"/);
        if (match) violationNews.add(match[1]);
      }
    }

    return (
      <div className="space-y-1">
        <div className="text-[11px] font-semibold text-gray-300">{label ? `${label} ` : ''}News Events During Trading — {data.news_events.length} high-impact</div>
        <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
          <div className="max-h-[200px] overflow-y-auto">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-black/60">
                <tr className="border-b border-white/10">
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Time (UTC)</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Currency</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Event</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.news_events
                  .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                  .map((evt, i) => {
                    const triggered = violationNews.has(evt.title);
                    return (
                      <tr key={i} className={triggered ? 'bg-red-500/10 border-b border-red-500/10' : 'border-b border-white/5'}>
                        <td className="px-2 py-1 text-gray-400 font-mono">{new Date(evt.date).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                        <td className="px-2 py-1 text-gray-300 font-medium">{evt.country}</td>
                        <td className="px-2 py-1 text-gray-400">{evt.title}</td>
                        <td className="px-2 py-1">
                          {triggered ? (
                            <span className="px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[8px] font-medium uppercase">Flagged</span>
                          ) : (
                            <span className="px-1 py-0.5 rounded bg-gray-500/20 text-gray-500 text-[8px] font-medium uppercase">No violation</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const renderPhaseTrades = (data: AnalysisResult['phase2'], label: string) => {
    if (!data || !data.trades || data.trades.length === 0) return null;
    const violationMap = buildViolationMap(data);

    return (
      <div className="space-y-1">
        <div className="text-[11px] font-semibold text-gray-300">{label} Trades — {data.trades.length} total</div>
        <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
          <div className="max-h-[300px] overflow-y-auto">
            <table className="w-full text-[10px]">
              <thead className="sticky top-0 bg-black/60">
                <tr className="border-b border-white/10">
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">ID</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Symbol</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Side</th>
                  <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Lots</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Open</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Close</th>
                  <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Duration</th>
                  <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Profit</th>
                  <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Violations</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t, i) => {
                  const violations = violationMap.get(t.position || t._id) || violationMap.get(t._id);
                  const isFlagged = !!violations;
                  const durationMin = t.duration * 60;
                  const durationStr = durationMin < 60
                    ? `${durationMin.toFixed(0)}s`
                    : durationMin < 3600
                      ? `${(durationMin / 60).toFixed(0)}m`
                      : `${(durationMin / 3600).toFixed(1)}h`;

                  return (
                    <tr
                      key={t._id || i}
                      className={isFlagged
                        ? 'bg-red-500/10 border-b border-red-500/10'
                        : 'border-b border-white/5 hover:bg-white/[0.02]'}
                    >
                      <td className="px-2 py-1 font-mono text-gray-500">{t.position || t._id}</td>
                      <td className="px-2 py-1 font-mono text-gray-300">{t.trdSymbol}</td>
                      <td className="px-2 py-1">
                        <span className={t.side === 'Buy' ? 'text-green-400' : 'text-red-400'}>{t.side}</span>
                      </td>
                      <td className="px-2 py-1 text-right text-gray-400">{t.lots}</td>
                      <td className="px-2 py-1 text-gray-500">{new Date(t.openTime).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="px-2 py-1 text-gray-500">{new Date(t.closeTime).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="px-2 py-1 text-right text-gray-400">{durationStr}</td>
                      <td className={`px-2 py-1 text-right font-medium ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {formatCurrency(t.profit)}
                      </td>
                      <td className="px-2 py-1">
                        {violations ? (
                          <div className="flex gap-0.5 flex-wrap">
                            {violations.map((v) => (
                              <span key={v} className="px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[8px] font-medium uppercase">
                                {v}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  };

  const isMultiPhase = account.type === 2 || account.type === 3;

  return (
    <div className="px-4 py-3 space-y-3 bg-white/[0.02] border-t border-white/5">
      {/* Action buttons */}
      <div className="flex justify-end gap-2">
        {(result.phase2?.total_deductions ?? 0) + (result.phase1?.total_deductions ?? 0) > 0 && (
          <button
            onClick={() => setSendEmailOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
          >
            <Mail className="h-3 w-3" />
            Send Email
          </button>
        )}
        <button
          onClick={onRevalidate}
          disabled={revalidating}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-3 w-3 ${revalidating ? 'animate-spin' : ''}`} />
          {revalidating ? 'Revalidating...' : 'Revalidate'}
        </button>
      </div>

      <SendViolationEmailModal
        account={account}
        result={result}
        isOpen={sendEmailOpen}
        onClose={() => setSendEmailOpen(false)}
      />

      {/* Account Summary — Phase 1 first for multi-phase */}
      <div className="space-y-2">
        {isMultiPhase && renderPhaseSummary(
          result.phase1,
          'Phase 1 Summary',
          account.phase1?.login
        )}
        {renderPhaseSummary(
          result.phase2,
          isMultiPhase ? 'Phase 2 Summary' : 'Account Summary',
          isMultiPhase ? account.login : undefined
        )}
      </div>

      {/* Violation Details — Phase 1 first */}
      {isMultiPhase && renderPhaseViolations(result.phase1, 'Phase 1')}
      {renderPhaseViolations(result.phase2, isMultiPhase ? 'Phase 2' : 'Phase 1')}

      {/* News Events */}
      {renderPhaseNewsEvents(result.phase2, isMultiPhase ? 'Phase 2' : '')}
      {isMultiPhase && renderPhaseNewsEvents(result.phase1, 'Phase 1')}

      {/* Trade Tables — Phase 1 first */}
      {isMultiPhase && renderPhaseTrades(result.phase1, 'Phase 1')}
      {renderPhaseTrades(result.phase2, isMultiPhase ? 'Phase 2' : '')}
    </div>
  );
}

// --- Challenge Dashboard Content ---
export function ChallengesSection() {
  const {
    accounts, loading, error, page, hasMore, search,
    expandedId, analysisResults, analyzingId, revalidatingId,
    totalAccounts, globalStats, notPassed, notPassedDetails, notPassedAnalysis,
    setPage, handleSearch, toggleExpand, revalidateAccount, refresh,
  } = usePassedChallenges();

  const COL_SPAN = 9;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Passed Challenge Accounts</h1>
          <p className="text-xs text-gray-500">
            Fully passed challenges — click a row to analyze trades for violations
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          title="Total Passed Challenges"
          value={totalAccounts}
          icon={Users}
        />
        <StatCard
          title="Analyzed"
          value={globalStats.analyzedCount}
          icon={Activity}
          subtitle={totalAccounts > 0 ? `${Math.round((globalStats.analyzedCount / totalAccounts) * 100)}%` : undefined}
        />
        <StatCard
          title="With Violations"
          value={globalStats.withViolations}
          icon={AlertTriangle}
          subtitle={globalStats.analyzedCount > 0 ? `${Math.round((globalStats.withViolations / globalStats.analyzedCount) * 100)}% of analyzed` : undefined}
        />
        <StatCard
          title="Total Deductions"
          value={formatCurrency(globalStats.totalDeductions)}
          icon={TrendingDown}
        />
      </div>

      {/* Violation Type Breakdown */}
      {globalStats.violationBreakdown.length > 0 && (
        <ViolationBreakdownCard data={globalStats.violationBreakdown} />
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search by login, account ID, or email..."
          className="w-full pl-9 pr-4 py-2 text-xs bg-white/5 border border-white/10 rounded-lg text-gray-200 placeholder-gray-600 focus:outline-none focus:border-white/20"
        />
      </div>

      {/* Not Passed Message */}
      {!loading && notPassed && (
        <GlassCard>
          <div className="py-4">
            <div className="text-center mb-4">
              <Ban className="h-7 w-7 mx-auto mb-2 text-yellow-400" />
              <p className="text-sm text-yellow-400 font-medium mb-1">Account Not Passed</p>
              {notPassedDetails ? (
                <p className="text-xs text-gray-400">
                  Login {notPassedDetails.login} (Account {notPassedDetails.accountId}) — {notPassedDetails.type}, Phase {notPassedDetails.phase}, Status {notPassedDetails.status}.
                  This account has not fully passed the challenge.
                </p>
              ) : (
                <p className="text-xs text-gray-400">
                  The searched account(s) have not fully passed their challenge.
                </p>
              )}
            </div>

            {/* Violation details for non-passed account */}
            {notPassedAnalysis && (
              <div className="border-t border-white/10 pt-4 space-y-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 flex items-center gap-1.5">
                  <AlertTriangle className="h-3 w-3" /> Violation Analysis (not saved)
                </div>

                {notPassedAnalysis.total_deductions > 0 ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                        <span className="text-gray-500 block">Total Deductions</span>
                        <span className="text-red-400 font-semibold">{formatCurrency(notPassedAnalysis.total_deductions)}</span>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                        <span className="text-gray-500 block">Violation Types</span>
                        <span className="text-white font-semibold">{notPassedAnalysis.violation_count}</span>
                      </div>
                      <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                        <span className="text-gray-500 block">Flagged Trades</span>
                        <span className="text-white font-semibold">{notPassedAnalysis.flagged_trade_count}</span>
                      </div>
                    </div>
                    {/* Per-type violation breakdown */}
                    {Object.entries(notPassedAnalysis.deduction_breakdown || {}).filter(([, amt]) => amt > 0).map(([type, amount]) => {
                      const tradeDetails = (notPassedAnalysis.violation_details || {})[type] || [];
                      return (
                        <div key={type} className="rounded-lg border border-white/10 bg-black/20 p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-gray-200">{notPassedAnalysis.violation_labels[notPassedAnalysis.violation_types.indexOf(type)] || type}</span>
                            <span className="text-xs font-semibold text-red-400">{formatCurrency(amount)}</span>
                          </div>
                          {tradeDetails.length > 0 && (
                            <div className="mt-2 space-y-1 max-h-[120px] overflow-y-auto">
                              {tradeDetails.map((td: { trade_id: string; explanation: string; amount: number }, i: number) => (
                                <div key={i} className="flex items-start gap-2 text-[10px]">
                                  <span className="text-gray-600 shrink-0 font-mono">{td.trade_id}</span>
                                  <span className="text-gray-400 flex-1">{td.explanation}</span>
                                  <span className="text-red-400 shrink-0">{formatCurrency(td.amount)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">No violations detected. {notPassedAnalysis.trades?.length || 0} trades analyzed.</p>
                )}

                {/* Trade table — always shown when trades exist */}
                {notPassedAnalysis.trades && notPassedAnalysis.trades.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] font-semibold text-gray-300">Trades — {notPassedAnalysis.trades.length} total</div>
                    <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
                      <div className="max-h-[300px] overflow-y-auto">
                        <table className="w-full text-[10px]">
                          <thead className="sticky top-0 bg-black/60">
                            <tr className="border-b border-white/10">
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Symbol</th>
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Side</th>
                              <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Lots</th>
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Open</th>
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Close</th>
                              <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Profit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {notPassedAnalysis.trades.map((t, i) => {
                              const isFlagged = Object.values(notPassedAnalysis.violation_details || {}).some(
                                (details) => details.some((d: { trade_id: string }) => d.trade_id === t._id)
                              );
                              return (
                                <tr key={t._id || i} className={isFlagged ? 'bg-red-500/10 border-b border-red-500/10' : 'border-b border-white/5'}>
                                  <td className="px-2 py-1 text-gray-300">{t.trdSymbol}</td>
                                  <td className={`px-2 py-1 ${t.side === 'buy' ? 'text-green-400' : 'text-red-400'}`}>{t.side}</td>
                                  <td className="px-2 py-1 text-right text-gray-300">{t.lots}</td>
                                  <td className="px-2 py-1 text-gray-400">{new Date(t.openTime).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                  <td className="px-2 py-1 text-gray-400">{new Date(t.closeTime).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                  <td className={`px-2 py-1 text-right font-medium ${t.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatCurrency(t.profit)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {/* News events during trading */}
                {notPassedAnalysis.news_events && notPassedAnalysis.news_events.length > 0 && (
                  <div className="space-y-1 mt-3">
                    <div className="text-[11px] font-semibold text-gray-300">News Events During Trading — {notPassedAnalysis.news_events.length} high-impact</div>
                    <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
                      <div className="max-h-[200px] overflow-y-auto">
                        <table className="w-full text-[10px]">
                          <thead className="sticky top-0 bg-black/60">
                            <tr className="border-b border-white/10">
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Time (UTC)</th>
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Currency</th>
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Event</th>
                              <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {notPassedAnalysis.news_events
                              .sort((a: { date: string }, b: { date: string }) => new Date(a.date).getTime() - new Date(b.date).getTime())
                              .map((evt: { title: string; country: string; date: string; impact: string }, i: number) => {
                                const triggered = Object.values(notPassedAnalysis.violation_details?.news || [])
                                  .some((v: { explanation: string }) => v.explanation.includes(`"${evt.title}"`));
                                return (
                                  <tr key={i} className={triggered ? 'bg-red-500/10 border-b border-red-500/10' : 'border-b border-white/5'}>
                                    <td className="px-2 py-1 text-gray-400 font-mono">{new Date(evt.date).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                                    <td className="px-2 py-1 text-gray-300 font-medium">{evt.country}</td>
                                    <td className="px-2 py-1 text-gray-400">{evt.title}</td>
                                    <td className="px-2 py-1">
                                      {triggered ? (
                                        <span className="px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[8px] font-medium uppercase">Flagged</span>
                                      ) : (
                                        <span className="px-1 py-0.5 rounded bg-gray-500/20 text-gray-500 text-[8px] font-medium uppercase">No violation</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </GlassCard>
      )}

      {/* Loading / Error */}
      {loading && (
        <div className="flex items-center justify-center h-32 text-gray-500">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" />
          Loading passed challenge accounts...
        </div>
      )}

      {error && !loading && (
        <GlassCard>
          <div className="text-center py-8">
            <AlertTriangle className="h-8 w-8 mx-auto mb-3 text-red-400" />
            <p className="text-sm text-red-400 mb-3">{error}</p>
            <Button variant="primary" size="sm" onClick={refresh}>Retry</Button>
          </div>
        </GlassCard>
      )}

      {/* Table */}
      {!loading && !error && (
        <GlassCard padding="none">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10">
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500 w-8"></th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Login</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Name</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Type</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Platform</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Addons</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Size</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Created</th>
                <th className="px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody>
              {accounts.length === 0 && (
                <tr>
                  <td colSpan={COL_SPAN} className="px-4 py-8 text-center text-xs text-gray-500">
                    No passed challenge accounts found.
                  </td>
                </tr>
              )}
              {accounts.map((acct) => {
                const id = acct.accountId.toString();
                const isExpanded = expandedId === id;
                const isAnalyzing = analyzingId === id;
                const result = analysisResults[id];
                const isMultiPhase = acct.type === 2 || acct.type === 3;

                return (
                  <Fragment key={id}>
                    <tr
                      className="border-b border-white/5 hover:bg-white/[0.03] cursor-pointer transition-colors"
                      onClick={() => toggleExpand(acct)}
                    >
                      <td className="px-3 py-2.5">
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
                          : <ChevronRight className="h-3.5 w-3.5 text-gray-500" />}
                      </td>
                      <td className="px-3 py-2.5">
                        {isMultiPhase ? (
                          <div className="flex items-center gap-1 flex-wrap">
                            {acct.phase1 && (
                              <>
                                <span className="text-[9px] text-gray-500 font-medium">P1:</span>
                                <span className="font-mono text-gray-400 text-xs">{acct.phase1.login}</span>
                              </>
                            )}
                            <span className="text-[9px] text-gray-600 font-medium ml-1">P2:</span>
                            <span className="font-mono text-red-400 text-xs">{acct.login}</span>
                          </div>
                        ) : (
                          <span className="font-mono text-red-400 text-xs">{acct.login}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs text-gray-300 whitespace-nowrap">
                          {acct.firstName && acct.lastName ? `${acct.firstName} ${acct.lastName}` : acct.email || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant={acct.type === 1 ? 'blue' : acct.type === 2 ? 'purple' : 'yellow'}>
                          {acct.typeLabel}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs text-gray-300">{parsePlanName(acct.planName).platform}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const { addons } = parsePlanName(acct.planName);
                          return addons[0] === 'No Add-on'
                            ? <span className="text-[10px] text-gray-600">No Add-on</span>
                            : <span className="text-[10px] text-gray-400">{addons.join(', ')}</span>;
                        })()}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-xs text-gray-300 whitespace-nowrap">{formatCurrency(acct.startingBalance)}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-[10px] text-gray-500 whitespace-nowrap">
                          {acct.addedUTC ? new Date(acct.addedUTC).toLocaleDateString() : '—'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        {acct.analysisStatus === 'cached' || result ? (
                          <Badge variant="green" className="!text-[10px]">Analyzed</Badge>
                        ) : (
                          <span className="text-[10px] text-gray-600">—</span>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={COL_SPAN} className="p-0">
                          {isAnalyzing && !result ? (
                            <div className="flex items-center justify-center py-8 gap-2">
                              <Loader2 className="h-4 w-4 text-blue-400 animate-spin" />
                              <span className="text-xs text-blue-300">Analyzing trades for violations...</span>
                            </div>
                          ) : result ? (
                            <ExpandedAnalysis result={result} account={acct} onRevalidate={() => revalidateAccount(acct)} revalidating={revalidatingId === acct.accountId.toString()} />
                          ) : (
                            <div className="flex items-center justify-center py-8">
                              <span className="text-xs text-gray-500">Click to analyze this account</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/10">
            <span className="text-[10px] text-gray-500">Page {page}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={!hasMore}
                className="px-2.5 py-1 text-[10px] rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:bg-white/10 disabled:opacity-30"
              >
                Next
              </button>
            </div>
          </div>
        </GlassCard>
      )}
    </div>
  );
}
