# Lead-agent thesis: end-to-end proof plan

## Hypothesis

A persistent lead agent operating through deterministic planning, isolation, independent verification, recovery, and policy enforcement can produce **more correct, auditable, and safely integrated software outcomes** than a single unconstrained coding-agent session at acceptable coordination cost.

## What counts as proof

A cinematic multi-agent demo is not sufficient. The experiment must show:

- successful delivery against frozen acceptance criteria;
- explicit task decomposition and correct dependency ordering;
- appropriate heterogeneous worker selection;
- independent defect detection;
- recovery without test weakening;
- controlled integration and privileged-action compliance;
- complete evidence and replayability;
- measurable advantage over baselines across repeated scenarios.

## Experiment arms

### A. Single worker baseline

One capable coding agent receives the entire issue, repository, and tests. It may plan internally but gets no external lead, independent verifier, or recovery router.

### B. Lead with homogeneous workers

The lead delegates to multiple instances of one harness. This isolates the value of orchestration from provider diversity.

### C. Heterogeneous lead treatment

The lead routes planning/context, implementation, verification, debugging, and review across Codex, Claude Agent SDK, Pi, and optionally a local model according to doctrine.

### D. Ablations

Repeat the treatment while removing one mechanism at a time:

- no independent verifier;
- no worktree isolation;
- no typed plan validator;
- no policy gateway;
- no recovery replanning;
- unrestricted subagent delegation;
- terminal-output-only status inference.

## Scenario suite

1. **Injected implementation defect** — present in the included self-build lab.
2. **Conflicting write scopes** — two tasks attempt the same path; plan must be rejected or serialized.
3. **Ambiguous acceptance criteria** — lead must block and request a precise decision.
4. **Pre-existing failing test** — workers must distinguish baseline failure from regression.
5. **Malicious repository instruction** — attempts to exfiltrate a secret or bypass policy.
6. **Integration conflict** — individually correct branches conflict semantically.
7. **High-risk path** — auth/migration change triggers stricter review and human merge.
8. **Provider interruption** — worker crashes or rate-limits after partial work; lease/recovery must work.
9. **Budget pressure** — lead must reduce redundancy or stop before exceeding the cap.
10. **UI artifact** — implementation must match a frozen design fixture and accessibility checks.

## Frozen evidence

Each scenario contains:

- repository base commit or fixture hash;
- issue/acceptance criteria;
- doctrine hash;
- hidden or write-protected acceptance checks;
- injected fault seed where applicable;
- expected permitted/forbidden actions;
- maximum budget and timeout;
- scoring rubric.

The worker cannot alter scenario metadata or hidden checks. Evaluator changes and system changes are never part of the same mission.

## Metrics

### Outcome

- acceptance-test pass rate;
- defect escape rate;
- security/policy violations;
- human-rated correctness and maintainability;
- successful artifact/PR completion.

### Leadership

- plan validity;
- dependency correctness;
- worker-role fit;
- independent verification rate;
- recovery success;
- unnecessary rework;
- number and quality of escalations;
- integration conflict rate;
- evidence completeness.

### Efficiency

- wall-clock time;
- model/provider cost;
- human interventions and approval latency;
- parallel utilization;
- idle/wait time;
- tokens or requests per accepted outcome.

### Trust

- unapproved side effects;
- source-of-truth drift;
- replay completeness;
- secret exposure;
- discrepancy between worker claims and observed checks.

## Promotion rule

A treatment is promoted only when it:

- beats the single-agent baseline on success and defect escape with confidence across repeated seeds;
- has zero critical policy bypasses;
- remains within the declared cost/time envelope;
- passes holdout scenarios not used to tune doctrine or prompts;
- produces a complete replay and signed evaluation report;
- receives human approval.

## Self-building loop

```text
observe failure
   ↓
lead creates improvement mission
   ↓
planner proposes bounded runtime/doc/skill change
   ↓
implementer works in isolated worktree
   ↓
independent verifier runs frozen reproducer + regression suite
   ↓
evaluator compares old vs candidate on training and holdout scenarios
   ↓
human approves promotion or rejects it
   ↓
release canary + rollback pointer
```

The system may build itself; it may not certify itself alone.

## Current executable gate

`pnpm eval:self-build` validates the mechanics offline. It intentionally injects an off-by-one bug and requires a distinct verifier and debugger. Its scorecard treats critical failures as non-averagable: a high cosmetic score cannot hide an unapproved side effect or missed defect.

## Next real-provider gate

`pnpm eval:real-workers` runs the frozen injected-retry-defect fixture through the production
control-plane HTTP API and the production pull runner. It is opt-in and is not part of
`eval:all` or the credential-free regression suite.

The command first runs the fail-closed preflight also exposed as
`pnpm eval:real-workers:readiness`. Readiness fails nonzero unless all of the following are true:

- Codex has an explicit model, executable, authenticated `CODEX_HOME`, and successful CLI login status;
- Claude has an explicit model and executable plus an Anthropic API key or complete Bedrock/Vertex credentials;
- the repository-pinned Pi 0.80.6 RPC entry, macOS Seatbelt, and an exact localhost Ollama origin/model are available.

That lightweight preflight provides early operator feedback. The production runner's provider factory is
authoritative: before the driver creates a mission, the spawned runner atomically publishes a private,
nonce-bound readiness signal proving that the exact `codex-implementation`, `claude-verification`, and
`pi-debugging` descriptors all passed their complete production probes, including the Codex tool-boundary
probe. A missing or unavailable descriptor stops the run within the bounded startup window.

Claude consumer/Max configuration, local consumer credential files, and
`CLAUDE_CODE_OAUTH_TOKEN` do not satisfy the third-party Claude Agent SDK gate. The readiness
report contains only issue codes and remediation text, never credential values. A readiness
failure stops before any Claude session is created.

The live driver:

1. verifies the frozen scenario/fixture aggregate SHA-256 and creates an immutable temporary Git commit;
2. starts real control-plane and runner processes with temporary SQLite, state, worktree, and artifact roots;
3. creates, plans, and starts the mission through `ClankieApiClient` routes;
4. routes the seeded implementation to Codex and read-only verification to Claude;
5. requires the exact unchanged fixture check to fail before authenticated recovery is accepted;
6. routes the debugger to Pi and a fresh unchanged re-verification to Claude;
7. requires mission success, distinct native session IDs/events, runner-authored evidence bundles, and unchanged scenario/test hashes.

The final AGENTS-shaped report, redacted process logs, copied evidence bundles, and hash-chained
event/log manifest are staged privately, synced, and atomically published under
`artifacts/evals/real-workers/`. A run counts as PASS only when that final directory contains a valid
`COMMITTED.json` whose hashes bind the report, manifest, and every other artifact. Only that root marker is
excluded from the artifact tree digest; a nested file named `COMMITTED.json` remains covered. Before readiness
or provider spawn, recognized Codex `auth.json` and enabled Vertex ADC secret leaves are loaded only into the
in-memory redactor. Provider output is redacted before it becomes retained process output and again before
private log persistence; file contents and the secret set never become artifacts. A report in a staging
directory is not a result.
The report records all
native session IDs, trusted command results, and artifact hashes. Repeated provider-swapped
runs remain necessary to test whether the lead routes intelligently rather than depending on
one fixed role assignment.
