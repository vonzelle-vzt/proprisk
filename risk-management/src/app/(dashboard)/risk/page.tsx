'use client';

import { useState } from 'react';
import {
  RefreshCw, FileText, RotateCcw, AlertTriangle,
} from 'lucide-react';
import type { PayoutAnalysisResult } from '@/components/payouts/expanded-payout';
import type { DashboardAccount } from '@/hooks/use-platform-dashboard';
import { GlassCard } from '@/components/ui/glass-card';
import { Tabs } from '@/components/ui/tabs';
import { SegmentToggle } from '@/components/ui/segment-toggle';
import { Button } from '@/components/ui/button';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { usePlatformDashboard } from '@/hooks/use-platform-dashboard';
import { FirmExposureBand } from '@/components/charts/firm-exposure-band';
import { ChallengesSection } from '@/components/risk/challenges-section';
import { SummaryStatCards } from '@/components/risk/summary-stat-cards';
import { OverviewSection } from '@/components/risk/overview-section';
import { FlaggedAccountsTab } from '@/components/risk/flagged-accounts-tab';
import { AllPayoutsTab } from '@/components/risk/all-payouts-tab';
import { MorningReportModal } from '@/components/risk/morning-report-modal';
import { LiabilityForecastSection } from '@/components/risk/liability-forecast';
import { useFundedDashboardDerived } from '@/components/risk/use-funded-dashboard-derived';

// --- Main Dashboard ---
export default function RiskDashboardPage() {
  const [segment, setSegment] = useState('funded');
  const { data, loading, error, refresh } = usePlatformDashboard();
  const [activeTab, setActiveTab] = useState('overview');
  const [flaggedPage, setFlaggedPage] = useState(1);
  const [payoutsPage, setPayoutsPage] = useState(1);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [reportData, setReportData] = useState<any>(null);
  const perPage = 20;

  // Expandable row state for flagged + payouts tabs
  const [dashExpandedId, setDashExpandedId] = useState<string | null>(null);
  const [dashAnalysisResults, setDashAnalysisResults] = useState<Record<string, PayoutAnalysisResult>>({});
  const [dashAnalyzingId, setDashAnalyzingId] = useState<string | null>(null);

  const analyzeDashAccount = async (acct: DashboardAccount) => {
    if (dashAnalysisResults[acct.accountId]) return;
    setDashAnalyzingId(acct.accountId);
    try {
      const res = await fetch(`/api/payouts/${acct.accountId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: acct.email }),
      });
      if (res.ok) {
        const json = await res.json();
        setDashAnalysisResults((prev) => ({ ...prev, [acct.accountId]: json.data }));
      }
    } catch { /* noop */ }
    finally { setDashAnalyzingId(null); }
  };

  const toggleDashExpand = (acct: DashboardAccount) => {
    if (dashExpandedId === acct.accountId) {
      setDashExpandedId(null);
    } else {
      setDashExpandedId(acct.accountId);
      if (!dashAnalysisResults[acct.accountId]) {
        analyzeDashAccount(acct);
      }
    }
  };

  const generateReport = async () => {
    setReportLoading(true);
    try {
      const res = await fetch('/api/reports/morning', { method: 'POST' });
      const json = await res.json();
      setReportData(json);
    } catch {
      // noop
    } finally {
      setReportLoading(false);
    }
  };

  // Date-filtered accounts + Overview-tab aggregates (severity, violation
  // breakdown, plan/country distribution, summary stats).
  const {
    filteredFlagged, filteredAll, filteredStats, filteredSeverity,
    filteredViolationBreakdown, filteredPlanDist, filteredCountryDist,
  } = useFundedDashboardDerived(data, startDate, endDate);

  const segments = [
    { id: 'funded', label: 'Funded Payouts' },
    { id: 'challenges', label: 'Challenges' },
  ];

  if (segment === 'challenges') {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <SegmentToggle segments={segments} active={segment} onChange={setSegment} />
        </div>
        <ChallengesSection />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <SegmentToggle segments={segments} active={segment} onChange={setSegment} />
        </div>
        <div className="flex items-center justify-center h-64 text-gray-500">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" />
          Loading live risk dashboard from the Trading Platform...
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <SegmentToggle segments={segments} active={segment} onChange={setSegment} />
        </div>
        <GlassCard>
          <div className="text-center py-8">
            <AlertTriangle className="h-8 w-8 mx-auto mb-3 text-red-400" />
            <p className="text-sm text-red-400 mb-3">{error || 'Failed to load dashboard'}</p>
            <Button variant="primary" size="sm" onClick={refresh}>Retry</Button>
          </div>
        </GlassCard>
      </div>
    );
  }

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'flagged', label: 'Flagged Accounts', count: filteredFlagged.length },
    { id: 'payouts', label: 'All Pending Payouts', count: filteredStats.totalPendingPayouts },
  ];

  return (
    <div className="space-y-5">
      {/* Firm-wide cross-asset exposure — Forex + Futures on one dashboard */}
      <FirmExposureBand />

      {/* Segment Toggle */}
      <div className="flex items-center gap-4">
        <SegmentToggle segments={segments} active={segment} onChange={setSegment} />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Risk Dashboard</h1>
          <p className="text-xs text-gray-500">Live portfolio risk overview from the Trading Platform</p>
        </div>
        <div className="flex items-center gap-2">
          <DateRangeFilter startDate={startDate} endDate={endDate} onStartChange={setStartDate} onEndChange={setEndDate} />
          {(startDate || endDate) && (
            <Button variant="ghost" size="sm" onClick={() => { setStartDate(''); setEndDate(''); }} className="!text-gray-500 hover:!text-gray-300">
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={generateReport} loading={reportLoading}>
            <FileText className="h-3.5 w-3.5 mr-1" /> Generate Risk Report
          </Button>
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {/* Payout-liability forecast — concrete, deterministic scenario modeling */}
      <LiabilityForecastSection />

      {/* Stat Cards */}
      <SummaryStatCards stats={filteredStats} />

      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {/* === OVERVIEW TAB === */}
      {activeTab === 'overview' && (
        <OverviewSection
          severity={filteredSeverity}
          violationBreakdown={filteredViolationBreakdown}
          planDist={filteredPlanDist}
          countryDist={filteredCountryDist}
          flagged={filteredFlagged}
          onViewAllFlagged={() => setActiveTab('flagged')}
        />
      )}

      {/* === FLAGGED ACCOUNTS TAB === */}
      {activeTab === 'flagged' && (
        <FlaggedAccountsTab
          flagged={filteredFlagged}
          page={flaggedPage}
          perPage={perPage}
          onPageChange={setFlaggedPage}
          expandedId={dashExpandedId}
          analyzingId={dashAnalyzingId}
          analysisResults={dashAnalysisResults}
          onToggleExpand={toggleDashExpand}
        />
      )}

      {/* === ALL PAYOUTS TAB === */}
      {activeTab === 'payouts' && (
        <AllPayoutsTab
          accounts={filteredAll}
          page={payoutsPage}
          perPage={perPage}
          onPageChange={setPayoutsPage}
          expandedId={dashExpandedId}
          analyzingId={dashAnalyzingId}
          analysisResults={dashAnalysisResults}
          onToggleExpand={toggleDashExpand}
        />
      )}

      {/* Morning Report Modal */}
      {reportData && (
        <MorningReportModal reportData={reportData} onClose={() => setReportData(null)} />
      )}
    </div>
  );
}
