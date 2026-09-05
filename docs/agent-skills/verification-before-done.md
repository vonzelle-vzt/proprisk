# Skill: verification before done

**Use when:** finishing any change in this repo, before reporting it as
complete. This is the repo's definition of "done" — not "the code looks
right," not "the types check." Load it at the end of a task, the way the
other four skills get loaded at the start of one.

## The repo's characteristic bug

The bug this codebase produces is not a crash. It is **a job that reports
success while doing less than it claims** — an error converted into a
benign-looking value (`null`, `false`, an empty array, a silently skipped
iteration) at a boundary where nothing downstream can tell "nothing to do"
from "could not do it."

Concretely, this has happened here more than once: a re-scoped unique index
left an `onConflict` clause matching nothing, so every write failed, was
caught, logged, and reported as "0 new records" — indistinguishable from a
clean run with nothing to find. A cron wrote to a table that no migration had
ever created; every insert failed silently and the feature appeared to work
while persisting nothing. A test harness's migration glob silently skipped
one file while still printing success.

**Ask of every background job or generator you touch: what would this look
like if it were doing nothing?** If the answer is "the same as doing
something," it needs an explicit failure count or it needs to throw instead
of returning a benign value.

## Definition of done

Run these, and paste the actual output — not a description of what you
expect it to say:

```bash
cd risk-management && npm run lint
cd risk-management && npm run typecheck
cd risk-management && npm run test
cd risk-management && npm run check:isolation      # if you touched anything tenant-scoped or added a migration
bash risk-management/supabase/tests/verify-isolation.sh   # if you touched a migration or RLS policy (needs local Postgres 17 on :55432)
bash scripts/release/check-banned-terms.sh          # if you touched anything that might ship publicly
node scripts/release/check-doc-links.mjs            # if you touched any Markdown link
cd risk-management && npm run build                 # part of verification, not a formality — only the bundler catches a server-only module leaking into a client bundle
```

Not every change needs every command — a pure-CSS change doesn't need
`check:isolation` — but the burden is on you to say which ones you skipped
and why, not to skip silently.

## "Report what was persisted, not attempted"

This phrase appears throughout the codebase's own comments
(`00024_morning_reports.sql`, the violation-report endpoints) for a reason:
a job's return value or your own report to the user should describe what
actually landed, not what the code was supposed to do. "Regenerated the
report" and "regenerated the report, but it was unchanged, so nothing new was
written" are different claims — collapsing them is exactly the silent-success
shape this repo keeps producing.

Apply the same standard to your own task report: don't write "added the
migration and it should work" — run it and say whether it applied, what it
created, and what the verification command printed.

## "Skipped is never a pass"

The rule engine reports a `skipped` rule with a reason, never a pass, a zero,
or an empty state — because a firm has to be able to tell "no breach
occurred" from "we didn't check." Apply this to your own verification too:
if a test suite skipped a suite, if a check ran against 0 files because a
glob was wrong, if a migration test silently applied fewer migrations than
it meant to — that is not a passing run. Count what you expected to be
checked and confirm the number, not just the exit code.

## Never claim a check passed without pasting its output

"Tests pass" is not evidence. The actual test-runner output — pass/fail
counts, or the specific green lines — is evidence. This matters doubly for
`check:isolation` and `verify-isolation.sh`: a script that exits 0 because it
found nothing to check is indistinguishable, from the exit code alone, from
one that ran every check and found no problems. Paste enough of the output
that a reader can tell which one happened.

## When a migration moves a constraint or renames something referenced elsewhere

Grep for the old name before calling the change done: `onConflict`,
`ON CONFLICT`, raw SQL index/constraint names, and any TypeScript that
assumed the old shape. The database will otherwise tell you about the
mismatch at runtime, inside a `catch` block, where nothing is listening.

## Common mistakes

- Reporting "ran the tests" after running only the file you changed, when
  the change could affect a shared type or a renderer used elsewhere in the
  same directory.
- Treating a lint or typecheck pass as sufficient evidence for a runtime
  behavior claim (e.g. "the report is now deterministic" needs the
  determinism test run, not just a clean `tsc`).
- Skipping `npm run build` because unit tests passed — client/server bundle
  boundary violations are invisible to `vitest` and `tsc` alike.
- Marking a step done because a background job's log line said "success"
  without checking what number of records it actually touched.
