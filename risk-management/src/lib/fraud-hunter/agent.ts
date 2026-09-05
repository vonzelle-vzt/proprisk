import { randomUUID } from 'crypto';
import { logError, logInfo } from '@/lib/logging/logger';
import { logAuditEvent } from '@/lib/deductions/audit';
import { upsertFraudInvestigation } from '@/lib/fraud-hunter/persistence';
import { detectCopyRings } from '@/lib/fraud-hunter/detectors/copy-ring';
import { detectSharedIdentity } from '@/lib/fraud-hunter/detectors/shared-identity';
import { detectCoordinatedPayouts } from '@/lib/fraud-hunter/detectors/coordinated-payout';
import { detectAccountChurning } from '@/lib/fraud-hunter/detectors/account-churning';
import { detectProfitManipulation } from '@/lib/fraud-hunter/detectors/profit-manipulation';
import type { FraudType, FraudDetectorResult, FraudHunterScanResult } from '@/types/fraud';

const DETECTOR_MAP: Record<FraudType, (tenantId: string) => Promise<FraudDetectorResult>> = {
  copy_ring: detectCopyRings,
  shared_identity: detectSharedIdentity,
  coordinated_payout: detectCoordinatedPayouts,
  account_churning: detectAccountChurning,
  profit_manipulation: detectProfitManipulation,
};

/**
 * Run the Fraud Hunter scan — orchestrates all detectors, persists findings,
 * and logs an audit trail. Every detector query and every persisted finding
 * is scoped to `tenantId`; there is no cross-tenant correlation.
 *
 * @param tenantId — Required. The tenant this scan runs for.
 * @param options.detectors — Specific detectors to run (all by default)
 * @param options.lookbackHours — Not used directly by this orchestrator but
 *   can be passed to detectors in future iterations
 */
export async function runFraudHunterScan(
  tenantId: string,
  options?: {
    detectors?: FraudType[];
    lookbackHours?: number;
  }
): Promise<FraudHunterScanResult> {
  const scanId = randomUUID();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Determine which detectors to run
  const allDetectors: FraudType[] = [
    'copy_ring',
    'shared_identity',
    'coordinated_payout',
    'account_churning',
    'profit_manipulation',
  ];
  const detectorsToRun = options?.detectors?.length
    ? options.detectors.filter(d => allDetectors.includes(d))
    : allDetectors;

  logInfo('Fraud Hunter scan started', {
    route: 'lib/fraud-hunter/agent',
    category: 'internal',
    scan_id: scanId,
    tenant_id: tenantId,
    detectors: detectorsToRun.join(','),
  });

  // Run selected detectors in parallel
  const promises = detectorsToRun.map(type => {
    const detector = DETECTOR_MAP[type];
    return detector(tenantId);
  });

  const settled = await Promise.allSettled(promises);

  // Collect results
  const results: FraudDetectorResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    const detectorType = detectorsToRun[i];

    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      logError(`Fraud Hunter: detector "${detectorType}" failed`, outcome.reason, {
        route: 'lib/fraud-hunter/agent',
        category: 'internal',
        tenant_id: tenantId,
      });
      // Push empty result so the detector still appears in output
      results.push({ fraud_type: detectorType, findings: [] });
    }
  }

  // Persist findings
  let newInvestigations = 0;
  let totalFindings = 0;
  let persistenceErrors = 0;

  for (const result of results) {
    for (const finding of result.findings) {
      totalFindings++;
      try {
        const investigation = await upsertFraudInvestigation(tenantId, result.fraud_type, finding);
        if (investigation) {
          newInvestigations++;
        }
      } catch (err) {
        // upsertFraudInvestigation throws on a genuine write failure (as
        // opposed to returning null for an already-handled duplicate) so
        // that a discarded finding is never mistaken for scan success.
        persistenceErrors++;
        logError('Fraud Hunter: failed to persist finding', err, {
          route: 'lib/fraud-hunter/agent',
          category: 'database',
          tenant_id: tenantId,
        });
      }
    }
  }

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  // Log audit event
  try {
    await logAuditEvent({
      action_type: 'fraud_hunter_scan',
      entity_type: 'fraud_investigation',
      entity_id: scanId,
      performed_by: 'fraud_hunter_agent',
      details: {
        scan_id: scanId,
        tenant_id: tenantId,
        detectors_run: detectorsToRun,
        total_findings: totalFindings,
        new_investigations: newInvestigations,
        persistence_errors: persistenceErrors,
        duration_ms: durationMs,
        started_at: startedAt,
        completed_at: completedAt,
      },
    });
  } catch (err) {
    logError('Fraud Hunter: failed to log audit event', err, {
      route: 'lib/fraud-hunter/agent',
      category: 'database',
      tenant_id: tenantId,
    });
  }

  logInfo('Fraud Hunter scan completed', {
    route: 'lib/fraud-hunter/agent',
    category: 'internal',
    scan_id: scanId,
    tenant_id: tenantId,
    duration_ms: durationMs,
    total_findings: totalFindings,
    new_investigations: newInvestigations,
    persistence_errors: persistenceErrors,
  });

  return {
    scan_id: scanId,
    started_at: startedAt,
    completed_at: completedAt,
    detectors_run: detectorsToRun,
    total_findings: totalFindings,
    new_investigations: newInvestigations,
    persistence_errors: persistenceErrors,
    results,
  };
}
