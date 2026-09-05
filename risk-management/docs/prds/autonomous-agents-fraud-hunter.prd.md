# PRD: Fraud Hunter Agent

**Status:** Implemented
**Priority:** P1
**Owner:** Risk Team
**Date:** 2026-03-15

## Status (2026-09-05)

Shipped as described below, and since made tenant-scoped: every detector takes
a required `tenantId` and runs inside `tenantDb(tenantId)`
(`src/lib/db/tenant-scoped.ts`), so cross-account correlation happens only
within one firm's own accounts. A prior version of this agent ran without
tenant scoping and would have surfaced one firm's accounts inside another
firm's investigation — see
[`self-serve-multi-tenant-saas.prd.md`](./self-serve-multi-tenant-saas.prd.md)
("Key design decisions"). A dedicated two-tenant test seeds identical bait
across two firms and asserts no finding's `account_ids` mixes them
(`src/lib/fraud-hunter/`). "No LLM" in the detectors below still holds — this
agent is rule-based scoring and clustering, not model judgment.

## Overview

Cross-account fraud detection agent that identifies patterns individual violation engines miss. Rule-based (no LLM), runs as cron every 15 min + on-demand via chat bot and API.

## Problem Statement

Individual violation engines (profit cap, HFT, martingale, etc.) operate on single accounts. Sophisticated fraud patterns — copy trading rings, shared identities, coordinated payouts — span multiple accounts and require cross-account correlation.

## Solution

5 specialized detectors running in parallel with confidence scoring, deduplication, and a human-in-the-loop review workflow.

## Detectors

### 1. Copy Trading Ring Detection
- **Algorithm**: Graph-based — builds adjacency from trade correlations, union-find for connected components
- **Signals**: Country match, plan similarity, balance ratios, deduction patterns
- **Config**: `min_correlated_trades: 5`, `correlation_threshold: 0.7`, `min_ring_size: 2`

### 2. Shared Identity Detection
- **Algorithm**: Multi-signal clustering on email domain, name match, country
- **Signals**: Email domain groups (excluding common providers), exact name match across emails, country clustering
- **Confidence**: Same domain+country: +30, similar prefix: +25, name match: +35, country: +10

### 3. Coordinated Payout Detection
- **Algorithm**: Sliding window clustering on payout request timestamps
- **Config**: `cluster_window_minutes: 60`, `min_cluster_size: 3`, `min_total_amount: 1000`

### 4. Account Churning Detection
- **Algorithm**: Group accounts by user/email, flag excessive creation with high fail rates
- **Config**: `max_accounts_per_user: 5`, `failed_account_threshold: 3`, `lookback_days: 90`

### 5. Profit Manipulation Detection
- **Algorithm**: Inverse PnL correlation across account pairs (same user or linked accounts)
- **Config**: `offset_threshold_pct: 0.80`, `min_offsetting_trades: 3`

## Data Flow
```
Cron (every 15 min) or Manual Trigger
  → Run 5 detectors in parallel (Promise.allSettled)
  → Each returns FraudFinding[]
  → Deduplicate via dedupe_key (fraud_type:sorted_accounts:YYYY-MM-DD)
  → Upsert to fraud_investigations table
  → Log audit event
  → Surface in dashboard + chat bot
```

## Database

Table: `fraud_investigations` (migration 00008)
- dedupe_key UNIQUE constraint prevents duplicate investigations
- GIN index on account_ids array for efficient lookups
- RLS: authenticated read, service_role manage

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/fraud-hunter/investigations` | GET | List/filter investigations |
| `/api/fraud-hunter/investigations/[id]` | GET/PATCH | Get/update investigation |
| `/api/fraud-hunter/scan` | POST | Manual scan trigger (rate: 2/min) |
| `/api/cron/fraud-hunter` | GET | Cron trigger (CRON_SECRET auth) |

## UI

- Fraud Hunter panel (`src/components/fraud/fraud-hunter-panel.tsx`) — can be added as tab to /risk page
- Investigation detail modal with evidence breakdown per fraud type
- Scan button with loading state
- Filter by status, fraud type, severity

## Chat Bot Intents

| Intent | Triggers | Action |
|--------|----------|--------|
| `fraud_hunt` | "fraud scan", "run fraud", "fraud hunter" | Runs scan, returns results |
| `fraud_report` | "fraud report", "open investigations" | Lists open investigations |

## Files

### New
- `src/types/fraud.ts`
- `src/config/fraud-hunter.ts`
- `src/lib/fraud-hunter/agent.ts`
- `src/lib/fraud-hunter/persistence.ts`
- `src/lib/fraud-hunter/detectors/copy-ring.ts`
- `src/lib/fraud-hunter/detectors/shared-identity.ts`
- `src/lib/fraud-hunter/detectors/coordinated-payout.ts`
- `src/lib/fraud-hunter/detectors/account-churning.ts`
- `src/lib/fraud-hunter/detectors/profit-manipulation.ts`
- 4 API route files
- 2 UI component files
- 1 React hook

## Success Metrics
- Detects fraud patterns within 15 minutes of data availability
- < 30% false positive rate on high-confidence (>70) findings
- Human review turnaround < 4 hours for critical findings
