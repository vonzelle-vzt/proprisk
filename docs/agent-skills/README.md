# Agent skills

Self-contained instruction sets for an agent (any model, any tool) to load
before touching a specific area of this codebase. Each one states when to use
it, the invariants that must not be violated, a step-by-step procedure, the
exact verification commands, and the mistakes that have actually happened
here.

| Skill | Load before |
|---|---|
| [tenant-isolation.md](./tenant-isolation.md) | Touching `src/lib/db/`, `src/lib/auth/`, a migration, a new tenant-scoped route or cron, or a provider adapter holding state. |
| [supabase-rls-and-auth.md](./supabase-rls-and-auth.md) | Writing or reviewing a migration, a policy, or any auth-reading code. |
| [rule-pack-authoring.md](./rule-pack-authoring.md) | Editing `src/lib/rulepack/` (schema, evaluate, primitives, presets, store) or drafting a rule pack config. |
| [violation-report-contract.md](./violation-report-contract.md) | Touching `src/lib/reports/violation/`, the `violation_reports` table, or any report endpoint. |
| [verification-before-done.md](./verification-before-done.md) | Finishing any change — this repo's definition of done, and the failure mode ("reports success while doing nothing") it exists to catch. |

## How to load one with any agent

There is nothing tool-specific here — these are plain Markdown files.

- **Paste it into the conversation** before asking an agent to make the
  change: "Read `docs/agent-skills/tenant-isolation.md`, then add a
  `webhooks` table."
- **Point the agent at the file path** if it can read files itself: "Before
  touching `src/lib/rulepack/`, read
  `docs/agent-skills/rule-pack-authoring.md`."
- Load more than one when a change spans areas — e.g. a new tenant-scoped
  table that also needs a migration should load both `tenant-isolation.md`
  and `supabase-rls-and-auth.md`.
- Always load `verification-before-done.md` at the end of a task, regardless
  of which other skills applied at the start of it.

## Why these exist

The invariants documented here were each found the expensive way — a real
defect in this codebase, not a hypothetical. Writing them down as loadable
instructions means the next change (by a person or an agent) starts from the
lesson instead of re-discovering it. See
`risk-management/docs/HOW-IT-WORKS.md` §8 for the project's honest current
state, and `risk-management/docs/prds/README.md` for the PRDs these skills
support.
