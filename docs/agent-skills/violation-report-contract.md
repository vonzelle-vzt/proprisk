# Skill: the violation-report contract

**Use when:** touching `risk-management/src/lib/reports/violation/` (`types.ts`,
`build.ts`, `render-pdf.ts`, `render-csv.ts`, `demo.ts`), the
`violation_reports` table (migration `00025`), or any of the three report
endpoints. This is the evidence artifact the product sells — the trade tape,
the rule as written, the arithmetic, the decision, and everything the firm did
about it, in one document a trader can be handed and a compliance reviewer can
open. See the full PRD: `risk-management/docs/prds/violation-reports.prd.md`.

## The `ViolationReport` type, in one paragraph

`ViolationReport` (`types.ts`) is plain data with no behaviour: a `header`
(firm, account, trader, phase), `rule` (as written, never re-resolved against
today's pack), `whatHappened`, `arithmetic` (an ordered list of
label/expression/value strings), `timeline`, `trades`, `accountSnapshot`,
`action` (queue status, decision, deduction), `history` (prior violations,
disputes), and `provenance` (data-fidelity gaps, an optional audit hash, an
optional quarantined LLM narrative, and which source rows were actually
found). `schemaVersion` is a literal `1` today. Optional fields are optional
because the **source row** may not carry them, not because they're cosmetic —
an absent field renders as an explicit gap (e.g. `"—"`), never a fabricated
value.

## The persisted payload + content hash

The assembled report is written once to `violation_reports.report_json` and
read back verbatim on every later request — never rebuilt from live tables at
download time. Three reasons that isn't just an optimization:

- `equity_snapshots` are pruned after 7 days; the intraday peak behind a
  trailing-drawdown breach is gone by week two of a dispute.
- The active rule pack keeps changing; rebuilding tomorrow would silently
  re-state a past breach against today's rule instead of the one in force
  when it fired.
- `accounts.balance` / `.equity` are live columns, overwritten on every poll —
  the value at detection time is not recoverable from them later.

`content_hash` is a sha256 over the **canonical, key-sorted** report with
`reportId` / `generatedAt` / `generatedBy` stripped — a hash of the facts, not
of one particular rendering of them (`canonicalJson`, `contentHashOf` in
`build.ts`). This makes the write idempotent by input: regenerating a report
whose underlying facts haven't changed returns the existing row
(`unchanged: true`); a genuine change in the facts produces a new row, and the
old one is never overwritten — a report already handed to someone must never
change under them.

## Determinism rules — all of these are load-bearing

1. **No `Date.now()` inside a renderer.** `render-pdf.ts` and `render-csv.ts`
   are pure functions of the `ViolationReport` object — nothing they emit may
   be derived from the wall clock, a live query, or randomness. The one
   legitimate clock read in this module is in `build.ts`
   (`input.now ?? new Date()`), which exists so tests can inject a fixed time;
   never add a second one.
2. **No LLM in the arithmetic path.** Generated prose lives only in
   `provenance.generatedNarrative`, always paired with the exact disclaimer
   `NARRATIVE_DISCLAIMER` ("Generated prose describing the decision; not part
   of the decision."). It must never feed `arithmetic`, `whatHappened`, or any
   other field the decision is defended on. `arithmetic` entries are
   deterministic strings built from stored numbers.
3. **PDF dates are pinned, not wall-clock.** pdfkit defaults `info.CreationDate`
   to `new Date()` — `render-pdf.ts` pins both `CreationDate` and `ModDate` to
   `report.generatedAt`, and generates the file with `compress: false` so the
   output stream is diffable. The trailer `/ID` is a digest of the info
   dictionary, so pinning the dates pins the id too. The result: the same
   report object renders to byte-identical PDF bytes on every call, which the
   test suite (`render-pdf.test.ts`) checks directly.
4. **`schemaVersion` bumps, never mutates in place.** Bump
   `VIOLATION_REPORT_SCHEMA_VERSION` only when a field's *meaning* changes.
   Old persisted rows keep their own version and must keep rendering under the
   meaning they were written with — a renderer must handle every schema
   version it might be asked to render, not just the latest.

## Adding a section without breaking old rows

1. Add the new field as **optional** on `ViolationReport`.
2. Update `build.ts` to populate it going forward; leave old persisted rows
   alone — do not backfill by mutating `report_json` in place (that would
   change `content_hash` semantics retroactively and invalidate the whole
   idempotent-by-input guarantee).
3. Update both renderers to treat the field's absence as an explicit gap, not
   a crash or a fabricated value — old rows will hit this path forever.
4. Bump `VIOLATION_REPORT_SCHEMA_VERSION` **only** if you changed what an
   *existing* field means (not for a purely additive optional field — additive
   fields don't need a version bump because old rows simply don't have them,
   which the renderer already has to handle).
5. Add a golden test asserting the old-schema-version fixture still renders
   correctly with the new renderer.

## Endpoints

| Route | Method | Auth |
|---|---|---|
| `/api/violations/[id]/report?format=pdf\|csv\|json` | GET | risk user, request-scoped client (RLS) |
| `/api/violations/[id]/report` | POST (regenerate) | risk manager/admin |
| `/api/violations/account/[accountId]/report` | GET (CSV, all violations on an account) | risk user |
| `/api/trader/[token]/violations/[id]/report?format=pdf\|csv` | GET | trader token only, via `tenantDb` — never a URL parameter; every failure is an undifferentiated 404 |

## Verification

```bash
cd risk-management && npx vitest run src/lib/reports/violation/
cd risk-management && npm run typecheck
```

`build.test.ts` covers the idempotency-by-content-hash behavior;
`render-pdf.test.ts` and `render-csv.test.ts` cover byte-for-byte
determinism. Run all three whenever `types.ts`, `build.ts`, or either
renderer changes — a change that only touches one renderer can still break
the other's assumptions about optional-field shape.

## Common mistakes

- Reading `report.generatedAt` for humans but computing something in
  `arithmetic` from `new Date()` "just for one field" — there is no safe
  partial exception to rule 1.
- Rebuilding the report at read time instead of persisting-and-reusing,
  because it "seems simpler" — this silently reintroduces the exact
  re-stating-against-today's-rule bug the persisted design exists to prevent.
- Putting LLM output directly into `whatHappened` or `arithmetic` instead of
  `provenance.generatedNarrative`.
- Forgetting `compress: false` or a fixed date when adding a new PDF section,
  which reintroduces non-determinism pdfkit defaults to.
- Bumping `VIOLATION_REPORT_SCHEMA_VERSION` for an additive field that didn't
  need it, which needlessly forces every consumer to handle a new version
  number for no semantic reason.
