# Screenshots

The manifest of every screenshot the documentation references. Nothing here
contains a real firm's data.

**All eleven are captured from demo mode** (`NEXT_PUBLIC_DEMO_MODE=true`),
which serves coherent mock data from every API with no database, no trading
platform and no keys. That now includes the two that used to need a seeded
throwaway instance: the trader page resolves the fixed demo token at `/a/demo`
(`risk-management/src/lib/trader/demo.ts`), and a violation report is assembled
from the same mock dataset (`risk-management/src/lib/reports/violation/demo.ts`),
so `GET /api/violations/100185-grid/report?format=pdf` returns a real PDF.

There is no public landing page or pricing page to capture. This is a
self-hosted admin console; the signed-out entry point is the login screen at
`/login`, not a marketing page, so it is not included as a screenshot here.

To regenerate any of them:

```bash
cd risk-management
NEXT_PUBLIC_DEMO_MODE=true npm run dev
```

then open the path in the table below and capture the viewport. The ten
browser captures are 1546x795; `13-violation-report-pdf.png` is page one of the
downloaded PDF rendered at A4, 595x842. Keep the filenames — every document
links to them by name.

Non-screenshot artwork does not live here: the README banner is
[`../assets/banner.jpg`](../assets/banner.jpg) (rendered from `banner.svg`, the editable source), and anything else that is drawn
rather than captured belongs in `docs/assets/` alongside it.

`scripts/release/check-doc-links.mjs` treats this list as its allowance: a
screenshot referenced by a document may be missing from disk only while it
appears below. A reference to a file that is not in this list is a typo and
fails the build.

| File | Captured at | What it shows |
|---|---|---|
| `03-risk-dashboard.png` | `/risk` | The risk dashboard: firm-wide exposure, payout-liability forecast, severity distribution, flagged accounts |
| `04-violations.png` | `/violations` | Violations grouped by rule, with a PDF and CSV download on every row |
| `05-violation-detail.png` | `/violations/account/100185` | One account's violation report: every breach with its trades and arithmetic, plus an account-wide CSV |
| `06-rules-presets.png` | `/rules/new` | The preset picker — seven firm-shaped starting points, each described by the rule shape it models |
| `07-backtest.png` | `/rules/demo-apex-futures` → Backtest | A shadow-mode reconciliation against what the platform reported, with one rule reported as not evaluated |
| `08-alerts.png` | `/alerts` | The live breach feed for the selected asset class |
| `09-disputes.png` | `/disputes` | Disputes pinned to the evidence pack as it stood at decision time, with overturn rate per rule |
| `10-trader-view.png` | `/a/demo` | A trader's own headroom page, reached by a tokenized link with no login |
| `11-evidence-pack.png` | `/evidence/demo-account-100185` | A hash-chained evidence pack, with Export JSON and Print / Save as PDF |
| `12-connections.png` | `/connections` | The integrations board: all ten adapters with transport, access model and enforcement support |
| `13-violation-report-pdf.png` | `GET /api/violations/100185-grid/report?format=pdf` | Page one of a generated violation report PDF — the document a firm hands a disputing trader |
