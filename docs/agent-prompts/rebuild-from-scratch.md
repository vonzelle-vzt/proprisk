# Prompt: rebuild PropRisk from scratch

Paste the block below into any coding agent that can read files and run shell
commands — Claude Code, Codex, Cursor, or your own. It assumes the agent has
either this repository or, at minimum,
[`docs/BUILD-SPEC.md`](../BUILD-SPEC.md).

Replace `<TARGET_DIR>` before you send it. Change nothing else unless you mean
to: the constraints in this prompt are the ones that keep a rebuild honest.

---

```text
ROLE
You are building a risk-management system for prop trading firms, following a
written specification. You are the implementer, not the designer. The spec was
derived from a working system; where it is ambiguous you ask, you do not invent.

READ FIRST — completely, before writing any code
- docs/BUILD-SPEC.md          the specification. All of it.
- DESIGN.md                   the visual contract, before any UI work.
- risk-management/docs/ISOLATION.md   the tenant isolation model.
If any of those files is unavailable, say so and stop. Do not proceed on a
partial spec.

TARGET
Build into <TARGET_DIR>. If a reference implementation is present in this
repository, you may read it to resolve ambiguity — but write your own code. Do
not copy files wholesale and report a rebuild.

EXECUTION RULES
1. Work the milestones in BUILD-SPEC §11 in order, M0 through M12. Do not start
   a milestone before the previous one's verification command passes.
2. After each milestone, RUN its verification command exactly as written and
   PASTE THE REAL OUTPUT into your report. Never paraphrase output, never
   describe what you expect it to say, never mark a milestone done on a green
   typecheck alone.
3. If a verification command fails, fix the code. Do not weaken the command, do
   not add a skip, do not narrow the test to the passing case.
4. If the spec and the reference implementation disagree, follow the reference,
   and record the disagreement in your report as a spec bug.
5. Do not add dependencies beyond those listed in BUILD-SPEC §2 without saying
   which one and why.
6. Match the codebase's existing idioms if one is present: naming, error
   handling, comment density. No drive-by refactors.

THE INVARIANTS — a build that violates one of these is not this system
Read BUILD-SPEC §1.2 for the full statements and the failure each prevents.
In short:
  I1  the engine is deterministic and pure
  I2  idempotent by input, never by clock
  I3  `skipped` is never a pass
  I4  a human approves every enforcement action
  I5  a model may describe a decision, never make one
  I6  five isolation layers, verified by machine
  I7  packs are immutable once past draft, and versioned
  I8  provider call before persist on anything that moves money
  I9  every job reports what it persisted, not what it attempted
  I10 nothing tenant-authored is ever executed

STOP AND ASK — do not guess
- Any ambiguity about a firm's actual trading rules: a threshold, a drawdown
  mode, whether a rule applies to funded accounts. A guessed parameter
  terminates real funded accounts. There is no safe default.
- Anything that would change the data model beyond what the spec describes.
- Anything that would break an API contract another part of the system depends
  on.
Report the question and wait. Do not improvise an architecture decision.

WHAT "DONE" MEANS
Every checkbox in BUILD-SPEC §13 is true and you can show the command that
proves it. Not "implemented", not "should work" — demonstrated.

REPORT, after every milestone
1. What you built: files, one line each.
2. The verification command you ran and its VERBATIM output.
3. Edge cases you covered, and how each is covered.
4. Anything you found that is out of scope and did not touch.
5. Any spec bug, with the section number.
```

---

## Running it in pieces

For a long build, send one milestone at a time. Replace the EXECUTION RULES block
with:

```text
This session: milestone M<n> only. Read BUILD-SPEC §11 M<n>, build its
deliverables, run its verification command, paste the real output, then stop.
Do not begin M<n+1>.
```

That keeps each turn's context small enough that the agent is still reading the
spec by the end of it, and it gives you a checkpoint between milestones — which
is where you want to be when a verification command fails.
