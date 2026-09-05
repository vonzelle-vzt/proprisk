import { tenantDb } from '@/lib/db/tenant-scoped';
import { logError } from '@/lib/logging/logger';
import { FRAUD_HUNTER_CONFIG } from '@/config/fraud-hunter';
import type { FraudDetectorResult, FraudFinding } from '@/types/fraud';

interface AccountSnapshot {
  platform_account_id: string;
  login: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  country: string | null;
  plan: string | null;
  starting_balance: number | null;
  balance: number | null;
  total_pnl: number | null;
  updated_at: string;
}

function extractEmailDomain(email: string): string {
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : '';
}

function extractEmailPrefix(email: string): string {
  const parts = email.split('@');
  return parts.length >= 1 ? parts[0].toLowerCase() : '';
}

function normalizeName(first: string | null, last: string | null): string | null {
  if (!first && !last) return null;
  return `${(first || '').trim().toLowerCase()} ${(last || '').trim().toLowerCase()}`.trim() || null;
}

function computeClusterConfidence(
  sharedDomain: boolean,
  sharedPrefix: boolean,
  sharedName: boolean,
  sharedCountry: boolean
): number {
  let score = 0;
  if (sharedDomain) score += 30;
  if (sharedPrefix) score += 25;
  if (sharedName) score += 35;
  if (sharedCountry) score += 10;
  return Math.min(score, 100);
}

function deriveSeverity(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function generateDedupeKey(accountIds: string[]): string {
  const sorted = [...accountIds].sort();
  const today = new Date().toISOString().slice(0, 10);
  return `shared_identity:${sorted.join(':')}:${today}`;
}

/**
 * Detect shared identity patterns across accounts.
 *
 * Looks for:
 * - Accounts sharing the same email domain (non-common providers)
 * - Accounts with similar email prefixes
 * - Exact name matches across different emails
 * - Country clustering combined with other signals
 */
export async function detectSharedIdentity(tenantId: string): Promise<FraudDetectorResult> {
  const findings: FraudFinding[] = [];
  const config = FRAUD_HUNTER_CONFIG.shared_identity;

  try {
    const db = tenantDb(tenantId, 'fraud-hunter shared-identity detector');

    const { data: snapshots, error } = await db
      .select(
        'account_snapshots',
        'platform_account_id, login, email, first_name, last_name, country, plan, ' +
        'starting_balance, balance, total_pnl, updated_at'
      )
      .order('updated_at', { ascending: false })
      .limit(1000);

    if (error) {
      logError('Shared identity detector: failed to fetch snapshots', error, {
        route: 'lib/fraud-hunter/detectors/shared-identity',
        category: 'database',
        tenant_id: tenantId,
      });
      return { fraud_type: 'shared_identity', findings: [] };
    }

    if (!snapshots || snapshots.length < 2) {
      return { fraud_type: 'shared_identity', findings: [] };
    }

    const accounts = snapshots as unknown as AccountSnapshot[];

    // Build indices
    const byDomain = new Map<string, AccountSnapshot[]>();
    const byName = new Map<string, AccountSnapshot[]>();
    const byCountry = new Map<string, AccountSnapshot[]>();

    // Common email providers to exclude from domain matching
    const commonDomains = new Set([
      'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
      'aol.com', 'protonmail.com', 'mail.com', 'live.com', 'msn.com',
      'yandex.com', 'zoho.com', 'gmx.com', 'tutanota.com',
    ]);

    for (const acct of accounts) {
      // Index by email domain (skip common providers)
      if (acct.email) {
        const domain = extractEmailDomain(acct.email);
        if (domain && !commonDomains.has(domain)) {
          if (!byDomain.has(domain)) byDomain.set(domain, []);
          byDomain.get(domain)!.push(acct);
        }
      }

      // Index by normalized full name
      if (config.check_name_match) {
        const name = normalizeName(acct.first_name, acct.last_name);
        if (name) {
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name)!.push(acct);
        }
      }

      // Index by country
      if (config.check_country_match && acct.country) {
        const country = acct.country.toLowerCase();
        if (!byCountry.has(country)) byCountry.set(country, []);
        byCountry.get(country)!.push(acct);
      }
    }

    // Track which account clusters we've already reported (avoid duplicates)
    const reportedClusters = new Set<string>();

    // Analyze domain clusters
    for (const [domain, domainAccounts] of byDomain) {
      if (domainAccounts.length < 2) continue;

      // Ensure they are different users (different emails)
      const uniqueEmails = new Set(domainAccounts.map(a => a.email));
      if (uniqueEmails.size < 2) continue;

      const accountIds = domainAccounts.map(a => a.platform_account_id);
      const clusterKey = [...accountIds].sort().join(':');
      if (reportedClusters.has(clusterKey)) continue;

      // Check for additional signals
      const countries = new Set(domainAccounts.map(a => a.country).filter(Boolean));
      const sharedCountry = countries.size === 1;

      // Check email prefix similarity
      const prefixes = domainAccounts.map(a => extractEmailPrefix(a.email || ''));
      let hasSimilarPrefix = false;
      for (let i = 0; i < prefixes.length && !hasSimilarPrefix; i++) {
        for (let j = i + 1; j < prefixes.length; j++) {
          // Simple substring check: if one prefix contains the other
          if (
            prefixes[i].length >= 3 && prefixes[j].length >= 3 &&
            (prefixes[i].includes(prefixes[j]) || prefixes[j].includes(prefixes[i]))
          ) {
            hasSimilarPrefix = true;
            break;
          }
        }
      }

      const confidence = computeClusterConfidence(true, hasSimilarPrefix, false, sharedCountry);
      if (confidence < 30) continue;

      const totalAtRisk = domainAccounts.reduce((s, a) => s + (a.balance || 0), 0);
      const severity = deriveSeverity(confidence);

      reportedClusters.add(clusterKey);
      findings.push({
        account_ids: accountIds,
        user_ids: [...uniqueEmails].filter(Boolean) as string[],
        primary_account: accountIds[0],
        confidence_score: confidence,
        severity,
        title: `Shared email domain: @${domain} (${domainAccounts.length} accounts)`,
        summary:
          `${domainAccounts.length} accounts share the @${domain} email domain. ` +
          `${sharedCountry ? `All from ${[...countries][0]}.` : ''} ` +
          `${hasSimilarPrefix ? 'Similar email prefixes detected.' : ''} ` +
          `Total balance at risk: $${totalAtRisk.toFixed(2)}.`,
        evidence: {
          detector: 'shared_identity',
          run_timestamp: new Date().toISOString(),
          shared_emails: [{ pattern: `*@${domain}`, accounts: accountIds }],
          shared_countries: sharedCountry ? [...countries] as string[] : [],
        },
        total_amount_at_risk: totalAtRisk,
        recommended_action: 'Verify identities and check for coordinated trading activity',
        dedupe_key: generateDedupeKey(accountIds),
      });
    }

    // Analyze name clusters (different emails, same name)
    for (const [name, nameAccounts] of byName) {
      if (nameAccounts.length < 2) continue;

      const uniqueEmails = new Set(nameAccounts.map(a => a.email).filter(Boolean));
      if (uniqueEmails.size < 2) continue;

      const accountIds = nameAccounts.map(a => a.platform_account_id);
      const clusterKey = [...accountIds].sort().join(':');
      if (reportedClusters.has(clusterKey)) continue;

      const countries = new Set(nameAccounts.map(a => a.country).filter(Boolean));
      const sharedCountry = countries.size === 1;

      const confidence = computeClusterConfidence(false, false, true, sharedCountry);
      if (confidence < 35) continue;

      const totalAtRisk = nameAccounts.reduce((s, a) => s + (a.balance || 0), 0);
      const severity = deriveSeverity(confidence);

      reportedClusters.add(clusterKey);
      findings.push({
        account_ids: accountIds,
        user_ids: [...uniqueEmails] as string[],
        primary_account: accountIds[0],
        confidence_score: confidence,
        severity,
        title: `Shared name "${name}" across ${nameAccounts.length} emails`,
        summary:
          `${nameAccounts.length} accounts share the exact name "${name}" but have different emails. ` +
          `Emails: ${[...uniqueEmails].join(', ')}. ` +
          `${sharedCountry ? `All from ${[...countries][0]}.` : ''} ` +
          `Total balance at risk: $${totalAtRisk.toFixed(2)}.`,
        evidence: {
          detector: 'shared_identity',
          run_timestamp: new Date().toISOString(),
          shared_names: [{ name, accounts: accountIds }],
          shared_countries: sharedCountry ? [...countries] as string[] : [],
        },
        total_amount_at_risk: totalAtRisk,
        recommended_action: 'Cross-reference KYC documents and verify distinct identities',
        dedupe_key: generateDedupeKey(accountIds),
      });
    }
  } catch (err) {
    logError('Shared identity detector: unexpected error', err, {
      route: 'lib/fraud-hunter/detectors/shared-identity',
      category: 'internal',
      tenant_id: tenantId,
    });
  }

  return { fraud_type: 'shared_identity', findings };
}
