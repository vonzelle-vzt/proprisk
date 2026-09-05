import type { PlatformPayout } from '@/types/platform';
import type { PayoutRecord } from '@/types/payouts';

/**
 * Convert a raw PlatformPayout from the API into a PayoutRecord
 * suitable for enrichment and display.
 */
export function buildRecordFromPayout(payout: PlatformPayout): PayoutRecord {
  const orderId = payout.orderId || payout._id || '';
  const accountId = payout.accountId || '';

  let dateRequested = payout.requested || payout.statusChanged || payout.inserted || '';
  if (dateRequested && /^\d{8}$/.test(dateRequested)) {
    dateRequested = `${dateRequested.substring(0, 4)}-${dateRequested.substring(4, 6)}-${dateRequested.substring(6, 8)}T00:00:00.000Z`;
  }

  const amount = typeof payout.amount === 'number' ? payout.amount : Number(payout.amount) || 0;
  const clientAmount = typeof payout.clientPayout === 'number' ? payout.clientPayout : Number(payout.clientPayout) || 0;

  return {
    id: payout._id || `${orderId}-${accountId}`,
    _id: payout._id,
    customerId: payout.customerId,
    userId: payout.userId,
    dateRequested,
    orderNumber: orderId.toString(),
    orderId: orderId.toString(),
    login: payout.login?.toString(),
    accountId: accountId.toString(),
    amount,
    clientAmount,
    fee: payout.fee || 0,
    profitSharePercentage: payout.profitSharePercentage,
    email: payout.email || '',
    kycStatus: 'Unknown',
    kycCountry: '',
    ipMismatch: false,
    platformViolations: [] as string[],
    notes: '',
    status: 'Pending' as const,
    plan: payout.plan || undefined,
    method: payout.method || undefined,
    destination: payout.destination || undefined,
    balance: payout.balance,
    totalPnL: payout.totalPnL,
    preApprovedStatus: payout.preApprovedStatus,
    preApprovedBy: payout.preApprovedBy || undefined,
  };
}
