import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { GlassCard } from '@/components/ui/glass-card';
import { formatCurrency } from '@/lib/utils/format';

/** "Generate Risk Report" morning-report result modal. */
export function MorningReportModal({ reportData, onClose }: { reportData: any; onClose: () => void }) {
  return (
    <Modal isOpen={!!reportData} onClose={onClose} title="Risk Report — Morning Report" size="xl">
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>Generated: {reportData.generated_at ? new Date(reportData.generated_at).toLocaleString() : 'Now'}</span>
          <Badge variant="green">Complete</Badge>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-center">
            <div className="text-lg font-bold text-white">{reportData.data?.pending_payouts?.count || 0}</div>
            <div className="text-[9px] text-gray-500 uppercase">Pending Payouts</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-center">
            <div className="text-lg font-bold text-white">{formatCurrency(reportData.data?.pending_payouts?.total_amount || 0)}</div>
            <div className="text-[9px] text-gray-500 uppercase">Total Amount</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-center">
            <div className="text-lg font-bold text-red-400">{reportData.data?.violations?.accounts_with_violations || 0}</div>
            <div className="text-[9px] text-gray-500 uppercase">Accounts Flagged</div>
          </div>
          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-center">
            <div className="text-lg font-bold text-red-400">{formatCurrency(reportData.data?.deductions?.total_amount || 0)}</div>
            <div className="text-[9px] text-gray-500 uppercase">Total Deductions</div>
          </div>
        </div>

        {/* Security Flags */}
        <GlassCard padding="sm">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Security Flags</h4>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div><span className="text-gray-500">Blacklisted:</span> <span className="text-red-400 font-semibold">{reportData.data?.security_flags?.blacklisted_users?.length || 0}</span></div>
            <div><span className="text-gray-500">KYC Failures:</span> <span className="text-yellow-400 font-semibold">{reportData.data?.security_flags?.kyc_failures || 0}</span></div>
            <div><span className="text-gray-500">High Risk:</span> <span className="text-red-400 font-semibold">{reportData.data?.security_flags?.high_risk_count || 0}</span></div>
          </div>
        </GlassCard>

        {/* Top Risk Accounts */}
        {reportData.data?.top_risk_accounts?.length > 0 && (
          <GlassCard padding="sm">
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Top Risk Accounts</h4>
            <div className="space-y-1.5">
              {reportData.data.top_risk_accounts.slice(0, 10).map((a: any) => (
                <div key={a.accountId} className="flex items-center gap-3 rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-xs">
                  <span className="font-mono text-red-400 w-[80px] shrink-0">{a.login}</span>
                  <span className="text-gray-400">Score: <span className="text-white font-semibold">{a.risk_score}</span></span>
                  <span className="text-gray-500 flex-1 truncate">{a.reasons?.join(', ')}</span>
                </div>
              ))}
            </div>
          </GlassCard>
        )}

        {/* Top Deduction Accounts */}
        {reportData.data?.deductions?.top_accounts?.length > 0 && (
          <GlassCard padding="sm">
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Top Deductions</h4>
            <div className="space-y-1.5">
              {reportData.data.deductions.top_accounts.map((a: any) => (
                <div key={a.accountId} className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-red-400">{a.login}</span>
                    <span className="text-gray-500">{a.plan}</span>
                  </div>
                  <span className="text-red-400 font-semibold">{formatCurrency(a.amount)}</span>
                </div>
              ))}
            </div>
          </GlassCard>
        )}

        {/* Formatted Report */}
        {reportData.summary && (
          <GlassCard padding="sm">
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Full Report</h4>
            <pre className="text-[11px] text-gray-300 whitespace-pre-wrap font-mono leading-relaxed max-h-[300px] overflow-y-auto">{reportData.summary}</pre>
          </GlassCard>
        )}
      </div>
    </Modal>
  );
}
