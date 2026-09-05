# PRDs

**Index date:** 2026-09-05

What each document below covers, its status, and when it was last touched.
[`MASTER_PRD.md`](./MASTER_PRD.md) is the top-level product summary; these are
the feature-level PRDs it links to.

| PRD | Status | Date | Covers |
|---|---|---|---|
| [MASTER_PRD.md](./MASTER_PRD.md) | Living document | 2026-09-05 | Product vision, the full feature list, database and cron overview. Start here. |
| [self-serve-multi-tenant-saas.prd.md](./self-serve-multi-tenant-saas.prd.md) | Shipped | 2026-09-05 | The conversion from one-deployment-per-client to one deployment serving every tenant: tenancy core, RLS, the rule-pack engine, self-serve signup through shadow mode, the versioned pack store, per-tenant credential vault, and the staged-launch enforcement gate. |
| [autonomous-agents-fraud-hunter.prd.md](./autonomous-agents-fraud-hunter.prd.md) | Implemented | 2026-09-05 (status note added; body dated 2026-03-15) | Cross-account fraud detection — 5 rule-based detectors, no LLM, tenant-scoped. |
| [autonomous-agents-violation-enforcer.prd.md](./autonomous-agents-violation-enforcer.prd.md) | Implemented | 2026-09-05 (status note added; body dated 2026-03-15) | Severity scoring, repeat-offender escalation, and the human-approval enforcement queue that both the legacy detectors and the rule-pack engine feed. |
| [violation-reports.prd.md](./violation-reports.prd.md) | Shipped | 2026-09-05 | Per-violation PDF/CSV/JSON decision records: why the payload is persisted rather than rebuilt, determinism rules, the three endpoints, and trader self-service access. |

## Reading order for a new contributor

1. `MASTER_PRD.md` — what exists and where.
2. `self-serve-multi-tenant-saas.prd.md` — why the platform is shaped the way
   it is (tenancy, rule packs, staged launch).
3. `violation-reports.prd.md` — the evidence artifact the whole product sells,
   per `risk-management/docs/HOW-IT-WORKS.md` §1.
4. The two agent PRDs — narrower, and each depends on the tenancy and rule-pack
   foundations described above.

## Honest current state

The multi-tenant build described in these PRDs has not yet run in
production. An earlier single-tenant version of this engine ran against live
funded accounts at a firm that is not named here; the tenancy layer, the
rule-pack engine and the reports are newer, and are verified — a green test
suite, a machine-checked isolation suite, deterministic golden vectors — but
verified is not the same as proven in production. See
[`../HOW-IT-WORKS.md`](../HOW-IT-WORKS.md) §8 for the full statement and what
must be true before a first paying customer.

## Related

- [`../agent-skills/README.md`](../../../docs/agent-skills/README.md) — loadable
  instructions for the areas these PRDs describe (tenant isolation, Supabase
  RLS/auth, rule-pack authoring, the violation-report contract, and the
  verification gate).
