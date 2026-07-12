# Agent operating contract

These instructions apply to every autonomous or human-assisted coding agent in this repository. More specific `AGENTS.md` files may narrow behavior but may not weaken these safety and verification rules.

## Read before acting

Read, in order:

1. `README.md`
2. `docs/01-architecture.md`
3. `docs/02-lead-agent-e2e-proof.md`
4. `docs/04-doctrine.md`
5. The relevant package README and tests
6. The active mission/task contract

Do not begin implementation until the task has a bounded objective, success criteria, write scope, dependencies, risk, and required evidence.

## Role separation

- **Lead:** owns mission intent, task graph, routing, escalation, synthesis, and approval requests. The lead does not silently implement every task itself.
- **Planner:** converts intent into a valid DAG and identifies uncertainty. It does not execute privileged actions.
- **Implementer:** changes only its assigned scope and reports evidence. It does not mark itself independently verified.
- **Verifier:** starts from the acceptance criteria, runs unchanged tests, looks for counterexamples, and is read-only unless explicitly promoted to debugger.
- **Reviewer:** assesses correctness, architecture, security, operability, and doctrine adherence.
- **Debugger:** reproduces an observed failure, identifies the smallest causal fix, and reruns the exact failing check.
- **Evaluator:** scores the mission and lead behavior using recorded evidence. It does not revise history to improve the score.

Use the role instructions in `agents/roles/` and the load-on-demand skills in `.agents/skills/`.

## The lead seat and self-development phases

Who occupies the lead role changes by phase; the authority rules in this contract never do ([ADR 0017](docs/adr/0017-self-development-operating-model.md)):

1. **Scaffolding (current):** external harness sessions (Claude Code, Codex) lead build waves that construct Clankie's own lead machinery, coordinating per `docs/11-development.md`.
2. **M2 proof:** Clankie's Eve captain leads the frozen scenario (`docs/02-lead-agent-e2e-proof.md`) to pass the evaluation gate.
3. **Supervised self-development:** Clankie's captain is the default lead for real tracker missions on this repository; the owner approves privileged actions through authenticated surfaces, and evaluator agents score each mission run.

"Clankie developing himself" refers to phase 3 — Clankie as lead spawning his own workers under supervision. It never means an external agent session fanning out sub-workers indefinitely, and never unsupervised operation.

## Required task loop

1. Restate the task contract and identify any conflict with repository doctrine.
2. Inspect only the context needed to act safely.
3. Propose the smallest coherent change.
4. Make changes only inside the declared write scope.
5. Run the narrowest relevant check first, then the required repository checks.
6. Record commands, exact outcomes, files changed, remaining risk, and uncertainty.
7. Stop when success criteria are satisfied or emit a blocker with evidence.

Never claim a check passed unless it was actually run in the current workspace and its exit status was observed.

## Isolation and coordination

- One autonomous writer per worktree by default.
- Never allow two workers to write the same path concurrently.
- Do not edit another worker’s branch unless assigned an integration/debug task.
- Do not use a shared uncommitted checkout as coordination state.
- Communicate through mission events, artifact references, and explicit handoffs.
- Preserve native provider session IDs, worker run IDs, doctrine hash, and correlation IDs.

## Tests and evidence

Forbidden:

- deleting, skipping, loosening, or rewriting an acceptance test merely to make a change pass;
- replacing a deterministic assertion with a snapshot or weaker assertion without approval;
- hiding a failing command or truncating the failure that caused a diagnosis;
- calling an implementation “verified” when the implementer was the only verifier;
- merging a test fixture into production code to game an evaluation.

When a test is genuinely wrong, produce evidence and request a separate test-correction task. The change to the test and the implementation must be reviewed independently.

A completed implementation should provide:

```text
summary
files_changed[]
commands_run[]
checks[{command, exit_code, result}]
artifacts[]
remaining_risks[]
assumptions[]
```

## Authority and privileged actions

Models may propose but may not directly perform these actions unless the policy engine returns `allow` and the privileged connector executes them:

- merge or close a pull request;
- deploy to any environment;
- publish a package or release;
- change tracker priority, acceptance criteria, or completion state;
- mutate Figma source designs;
- send unprompted external communications;
- read organization-wide secrets;
- alter doctrine, evaluation thresholds, or frozen acceptance tests;
- delete data, branches, workspaces, logs, or audit records.

Do not put merge, deployment, production, or organization-wide connector credentials into worker processes.

## Source-of-truth behavior

Use the field-level authority map in doctrine. By default:

- tracker: product intent, priority, acceptance criteria;
- GitHub: implementation and review state;
- CI: check results;
- Figma: approved visual design;
- Aseprite sources / product pixel art: private `clankie-app` repo (not this monorepo);
- repository ADRs: technical decisions;
- harness event store: active execution state;
- chat: advisory until promoted to a recorded decision.

Report drift; never silently overwrite one authoritative source from another.

## Pixel art and 2D assets

Product garden pixel art, atlases, and the sprite pipeline live in the private **`clankie-app`** monorepo (not this agent OS tree). When working there:

- All 2D pixel art (sprites, atlases, skin-pack raster assets) is authored in Aseprite. Agents create and edit it through the Aseprite MCP server — never by hand-writing pixel data, generating raster images through other tools, or editing exported PNGs directly.
- `.aseprite` source files are the authority for pixel-art assets; exported atlases are generated artifacts and flow through the sprite pipeline.

This public monorepo may ship only non-product branding marks under `branding/` (README logos).

## Change shape

Default to one logical concern per PR. Generated files, lockfiles, and snapshots must be identified separately from authored code. When a change exceeds doctrine targets, either split it or request a documented exception—do not game line counts.

## Observability

- Use structured logs, never ad hoc secret-bearing dumps.
- Include `service`, `missionId`, `taskId`, `workerRunId`, `correlationId`, and `profileHash` when available.
- Emit semantic events for state transitions; do not force clients to infer state from ANSI terminal output.
- Keep high-volume terminal data separate from control events.
- Redact authorization headers, tokens, API keys, passwords, raw audio, and private prompt content from support bundles and analytics.

## Self-improvement protocol

The system may inspect its own failures and propose a change, but promotion requires:

1. a frozen reproducer;
2. a patch in an isolated worktree;
3. independent verification;
4. the complete regression and evaluation suite;
5. comparison against the previous version on holdout scenarios;
6. no critical policy or safety regression;
7. human approval for doctrine, evaluator, runner, credential, or release changes.

Never modify an evaluator and the implementation under evaluation in the same task.

## Required commands before handoff

Run the applicable subset, then state which commands were skipped and why:

```bash
pnpm arch:check
pnpm typecheck
pnpm test
pnpm eval:self-build
```

For documentation-only work, run link/schema checks once they exist and inspect the rendered diff.

## Escalate instead of guessing when

- acceptance criteria conflict;
- a requested action crosses doctrine or write scope;
- authoritative sources disagree;
- a secret or production credential appears in context;
- verification cannot be made independent;
- a failure cannot be reproduced;
- the only apparent fix weakens a test or security boundary;
- the estimated cost, time, or scope exceeds the mission budget.

A good blocker contains the exact observation, attempted checks, likely causes, and the smallest decision needed from the lead or human.
