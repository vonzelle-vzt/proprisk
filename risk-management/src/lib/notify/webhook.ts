import { createAdminClient } from '@/lib/supabase/admin';
import { logError, logInfo } from '@/lib/logging/logger';

/**
 * Breach notification fan-out — webhook + Slack, alongside the existing email
 * path (src/lib/emails/*), so a risk desk sees a breach where they actually
 * work instead of only in their inbox.
 *
 * Per-tenant config: there is no per-tenant settings table yet (the `tenants`
 * row only carries `branding_json`, and adding a column is a migration, which
 * is out of scope here — supabase/** is explicitly off-limits for this task).
 * Until that table exists, a tenant's webhook URL is resolved from an env var
 * namespaced by its slug, falling back to a single global env var — the same
 * "tenant override, global fallback" shape already used for provider config
 * (src/lib/providers/adapters/base.ts's `getProviderConfig(id, tenantId)`).
 *
 *   RISK_WEBHOOK_URL_<SLUG>        generic JSON webhook for tenant <slug>
 *   RISK_SLACK_WEBHOOK_URL_<SLUG>  Slack incoming webhook for tenant <slug>
 *   RISK_WEBHOOK_URL               fallback generic webhook (all tenants)
 *   RISK_SLACK_WEBHOOK_URL         fallback Slack webhook (all tenants)
 *
 * Every call is fail-soft: a 500, a timeout, or a missing URL is logged and
 * swallowed. A notification channel being down must never block or fail a
 * detection — the enforcement_queue row (the thing that actually matters) is
 * already committed by the time this runs.
 */

function envKeyFromSlug(slug: string): string {
  return slug.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

async function resolveTenantSlug(tenantId: string): Promise<string | null> {
  try {
    const { data } = await createAdminClient().from('tenants').select('slug').eq('id', tenantId).maybeSingle();
    return data?.slug ?? null;
  } catch {
    return null;
  }
}

async function resolveWebhookUrls(tenantId: string): Promise<{ generic: string | null; slack: string | null }> {
  const slug = await resolveTenantSlug(tenantId);
  const key = slug ? envKeyFromSlug(slug) : null;

  const generic = (key && process.env[`RISK_WEBHOOK_URL_${key}`]) || process.env.RISK_WEBHOOK_URL || null;
  const slack = (key && process.env[`RISK_SLACK_WEBHOOK_URL_${key}`]) || process.env.RISK_SLACK_WEBHOOK_URL || null;

  return { generic, slack };
}

export interface BreachNotificationPayload {
  tenantId: string;
  accountId: string;
  violationType: string;
  severity: string;
  amount: number;
  summary: string;
  enforcementQueueId?: string;
  /**
   * `violations.id` for the decision record behind this breach. Optional
   * because not every caller has one; the detection cron now always does, and
   * a webhook consumer needs it to link back to the evidence.
   */
  violationId?: string;
}

async function postWithTimeout(url: string, body: unknown, timeoutMs = 5000): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`webhook returned ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget-but-awaited breach notification. Never throws — failures
 * are logged with the tenant/account context and otherwise ignored.
 */
export async function notifyBreach(payload: BreachNotificationPayload): Promise<void> {
  const { generic, slack } = await resolveWebhookUrls(payload.tenantId);
  if (!generic && !slack) return;

  const jobs: Promise<void>[] = [];

  if (generic) {
    jobs.push(
      postWithTimeout(generic, {
        type: 'breach_detected',
        tenant_id: payload.tenantId,
        account_id: payload.accountId,
        violation_type: payload.violationType,
        severity: payload.severity,
        amount: payload.amount,
        summary: payload.summary,
        enforcement_queue_id: payload.enforcementQueueId,
        violation_id: payload.violationId,
      }).catch((err) => {
        logError('Breach webhook delivery failed (non-blocking)', err, {
          category: 'internal',
          tenant_id: payload.tenantId,
          account_id: payload.accountId,
        });
      })
    );
  }

  if (slack) {
    const text = `:rotating_light: *${payload.violationType}* breach on account \`${payload.accountId}\` — ${payload.summary} (${payload.severity}, $${payload.amount.toFixed(2)})`;
    jobs.push(
      postWithTimeout(slack, { text }).catch((err) => {
        logError('Breach Slack notification failed (non-blocking)', err, {
          category: 'internal',
          tenant_id: payload.tenantId,
          account_id: payload.accountId,
        });
      })
    );
  }

  await Promise.allSettled(jobs);
  logInfo('Breach notification fan-out complete', {
    category: 'internal',
    tenant_id: payload.tenantId,
    account_id: payload.accountId,
    channels: [generic ? 'webhook' : null, slack ? 'slack' : null].filter(Boolean).join(',') || 'none',
  });
}
