# PRD: Violation Enforcer Agent

**Status:** Implemented
**Priority:** P1
**Owner:** Risk Team
**Date:** 2026-03-15

## Status (2026-09-05)

Shipped as described below. The enforcement queue this agent writes to is now
also the destination for rule-pack breaches from the live detection cron
(`src/lib/rulepack/live.ts`), not only the nine legacy per-account engines —
so a queued item's severity score and repeat-offender history apply
uniformly regardless of which engine produced the finding. Every recommendation
still requires human approval before a deduction executes; nothing here makes
an enforcement decision on its own.

## Overview

Smart enforcement orchestrator on top of the existing 9 violation engines. Scores severity, tracks repeat offenders with escalating penalties, and queues recommendations for human confirmation before executing deductions.

## Problem Statement

The existing violation worker auto-executes deductions immediately without human review. This creates risk of erroneous deductions and provides no visibility into enforcement decisions. Repeat offenders receive the same penalties regardless of history.

## Solution

Feature-flagged (`ENFORCEMENT_AGENT_ENABLED=true`) enforcement pipeline that intercepts violations, assesses severity, generates recommendations, and queues them for human approval.

## Severity Scoring (0-100)

| Factor | Points | Condition |
|--------|--------|-----------|
| Base violation type | 5-25 | copy=25, martingale=20, grid=20, profit_cap=15, overleveraging=15, hft=10, news=10 |
| Deduction amount | 0-20 | >$500: 20, >$200: 15, >$100: 10, >$50: 5 |
| Repeat same type | 0-25 | 1 prior: +5, 2-3: +10, 4-5: +15, 6+: +25 |
| Multiple types (30d) | 0-10 | 3+ distinct: +10 |
| New account (<7d) | 0-10 | +10 |
| Pending payout | 0-10 | Has payout: +5, >$1000: +10 |
| Banned activity | 0-15 | Account banned for this type: +15 |

**Escalation levels**: normal (0-25), elevated (26-50), urgent (51-75), critical (76-100)

## Repeat Offender Multiplier

| Offense | Multiplier | Window |
|---------|-----------|--------|
| 1st | 1.0x | — |
| 2nd | 1.5x | 30 days |
| 3rd | 2.0x | 30 days |
| 4th+ | 2.5x (cap) | 30 days |

## Escalation Rules

- **Time-based**: normal→12h→elevated→4h→urgent→1h→critical
- **Volume-based**: 3+ pending per account → urgent
- **Amount-based**: >$1000 total per account → critical
- **Auto-expire**: 48 hours unreviewed → expired

## Worker Integration

```
ENFORCEMENT_AGENT_ENABLED=false (default):
  violation → worker → executeDeduction() [existing behavior]

ENFORCEMENT_AGENT_ENABLED=true:
  violation → worker → assessAndRecommend() → enforcement_queue
  human approves → executeDeduction() [existing pipeline]
  human rejects → record decision, no deduction
```

## Database

Tables (migration 00009):
- `enforcement_queue` — pending recommendations with severity, escalation, expiry
- `account_violation_history` — materialized repeat offender tracking with sliding windows (24h, 7d, 30d)

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/enforcement/queue` | GET | List queue with filters |
| `/api/enforcement/queue/[id]` | PATCH | Approve/reject single |
| `/api/enforcement/batch` | POST | Batch approve/reject |
| `/api/enforcement/summary` | GET | Queue stats |
| `/api/enforcement/history/[accountId]` | GET | Account history |
| `/api/cron/enforce` | GET | Expire stale + escalate |

## UI — Enforcement Dashboard (`/enforcement`)

- Summary stat cards (pending, critical, total amount, oldest)
- Filter bar (status, escalation, violation type)
- Queue table with inline approve/reject + batch selection
- Detail modal with severity breakdown, history, amount calculation
- Sidebar nav item with Shield icon

## Chat Bot Intents

| Intent | Triggers | Action |
|--------|----------|--------|
| `enforcement_queue` | "enforcement queue", "pending enforcement" | Lists pending items |
| `enforcement_summary` | "enforcement summary", "enforcer status" | Queue overview stats |
| `repeat_offenders` | "repeat offenders", "worst offenders" | Top repeat violators |

## Files

### New
- `src/types/enforcement.ts`
- `src/lib/enforcement/severity.ts`
- `src/lib/enforcement/agent.ts`
- `src/lib/enforcement/queue-manager.ts`
- `src/lib/enforcement/escalation.ts`
- 6 API route files
- 4 UI component files

### Modified
- `src/lib/violations/worker.ts` — feature-flagged enforcement branch
- `src/components/layout/sidebar.tsx` — nav item
- Chat bot: types, parser, formatter, route

## Success Metrics
- Zero auto-deductions when enforcement mode is on (all go through queue)
- Average human review time < 2 hours for urgent items
- Repeat offender penalty escalation reduces recidivism by 20%
