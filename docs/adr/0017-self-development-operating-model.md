# ADR 0017: Self-development operating model — Clankie leads, humans and evaluators supervise

Status: accepted (James, 2026-07-11).

## Decision

"Clankie developing himself" means Clankie's own Eve captain occupies the **lead** role for missions on this repository — planning, spawning its own workers, routing, and requesting approvals — while the humans and any external agent sessions move to the supervision bench: observing through the operator console, approving privileged actions, and scoring mission runs. It never means an external agent session fanning out sub-workers indefinitely, and it never means unsupervised.

The lead seat changes hands by phase. Authority rules never do.

## Phases

1. **Scaffolding (current).** External harness sessions (Claude Code, Codex leads on the Herdr stage) run build waves that construct Clankie's own lead machinery — planner, worker adapters, status events, console, provider auth. They coordinate through the interim tracker protocol in `docs/11-development.md`.
2. **M2 proof.** Clankie's Eve captain leads the frozen scenario (`docs/02-lead-agent-e2e-proof.md`): typed plans, real Codex/Claude/Pi workers, independent verification, human merge approval through the minimal console. The evaluation gate — treatment beats the single-agent baseline with zero policy bypasses — is the audition for the lead seat.
3. **Supervised self-development.** Clankie's captain is the default lead for real tracker missions on this repository. The owner observes via the console and approves merges and other privileged actions through authenticated surfaces; evaluator agents (or external agent sessions acting as evaluators) score each mission run against recorded evidence using the evaluation skills. External sessions lead again only for work Clankie cannot yet do, and each such case is a signal to file the capability gap.

## Invariants across all phases

- The `AGENTS.md` role separation, privileged-action list, test-integrity rules, and self-improvement protocol apply identically whether the lead is a scaffolding session or Clankie's captain.
- Approval gates live on authenticated surfaces; ambient channels never carry approval authority (ADR 0010).
- The evaluator is never the implementer, and evaluator changes never ride with the implementation under evaluation.
- Phase transitions are earned by evidence (the M2 gate for phase 2 → 3), not asserted.

## Options weighed

- **Session memory / Linear descriptions only** — rejected as the record: any agent working in this repository must learn the operating model from the repository itself, without external context.
- **A load-on-demand skill as the primary record** — rejected: skills load on task match, but this framing must reach every agent before it acts, which is `AGENTS.md`'s job. The ceremony skills (`plan-mission`, `evaluate-lead-run`, `verify-independently`) implement the phases; this ADR and the `AGENTS.md` section define them.
