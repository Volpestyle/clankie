# Orchestration doctrine

Doctrine is a versioned operating contract, not a prompt-only preference sheet.

## Ceremony presets

User-facing doctrine starts from one of three integration-ceremony presets:

| Preset         | External connectors | Integration path | Change shape                         |
| -------------- | ------------------- | ---------------- | ------------------------------------ |
| `rawdog`       | none required       | direct to main   | broad scope, typecheck + unit checks |
| `structured`   | optional            | large PRs        | generous line budgets                |
| `fine-control` | required bindings   | review gate      | small PRs, full checks, no expansion |

Presets govern ceremony, not safety. `self-build-lab` is an internal evaluation fixture. High-assurance operation is an overlay layered over a preset, so assurance does not consume a fourth slot on the ceremony axis. An overlay may tighten planning, topology, verification, budgets, risk posture, actions, and memory, but it never replaces the base preset's identity, ceremony, or authority bindings.

## Change-shape task classes

The smallest coherent change remains the default. A task may use a broader
change shape only through an explicit doctrine class whose entry conditions and
evidence obligations are part of the task contract.

### Sanctioned structural refactor

A sanctioned structural refactor is tracker-authorized, behavior-preserving
structural work whose coherent boundary is intentionally larger than the
default change target. It is a planning and change-shape class applied to the
existing `implementation` task kind, not a new routing kind or a general scope
exception.

Before the task is leased, its contract must:

1. reference a tracker issue whose sanction is authored or confirmed by the
   source bound to `product_intent`, explicitly states the structural intent,
   and supplies acceptance criteria;
2. bound the write scope and record the affected structural boundaries,
   expected file count and changed-line range, and why a smaller slice would not
   be coherent;
3. name the exact unchanged test and verification commands that must be green
   immediately before and after the refactor, and explain why those commands
   meaningfully exercise every affected boundary; and
4. state that no observable behavior or semantic diff is intended or claimed.

Contracts should name boundary-stable, package-level commands rather than
file-path-specific commands that relocation would invalidate.

The recorded size expectation replaces the smallest-change target only for that
task. It is a contract obligation, not a claim that the current runtime
deterministically enforces file-count or changed-line limits. If the actual diff
exceeds either expectation, the lead or integration owner must amend the
contract or replan the task before integration and record the decision in the
sanctioning tracker thread. Any separately enforced profile constraint still
applies.

The implementer records both green command outcomes and reports structural
edits separately from generated or lockfile churn. Semantic test changes,
including changed assertions, fixture contents, or expectations, block the class.
Mechanical test relocation and import-path updates are permitted when reported
as mechanical test churn separate from the structural edits; the verifier must
confirm that the test diff contains only relocation and import-path updates.

A distinct verifier reruns the unchanged commands, explicitly confirms that
they meaningfully cover the refactored boundaries, checks for behavior
counterexamples, and remains independently attributable. The reviewer also
confirms the coverage claim and signs off that the resulting boundaries match
the tracker-sanctioned structural intent. A red baseline, a changed verification
command, a semantic test diff, or a discovered need for behavior change blocks
the class. A verifier-found behavior counterexample fails the task; a discovered
semantic diff never ships from this class as an unintended change. Behavior
changes must move to a separate task with their own acceptance criteria and
verification.

[ADR 0037](adr/0037-sanctioned-structural-refactor-task-class.md) records this
change-shape decision and its runtime boundary.

## Control categories

- **Preference:** influences planner scoring; may be exceeded with explanation.
- **Target:** measured after execution; produces warnings/recommendations.
- **Constraint:** scheduler/validator enforces deterministically.
- **Permission:** policy gateway enforces; model cannot bypass.
- **Authority:** resolves which external source owns a field.
- **Topology:** routes task classes to Eve subagents, visible runner workers, headless workers, or humans.

## Resolution order

```text
built-in safety floor
  → organization
  → workspace
  → repository
  → mission
  → task
```

A lower layer may become stricter. It may not loosen a higher-scope deny. Compile layers into an immutable effective profile and attach its hash to every mission, task, approval, and event.

## Current schema areas

- planning/change granularity;
- scope expansion;
- parallelism and delegation depth;
- worker topology/routing;
- verification independence and checks;
- cost/time/retry budgets;
- role-first source authority bindings;
- connector risk-class posture;
- action policies and obligations;
- memory retention and propagation.

## Enforcement projections

A compiled profile produces:

- a concise planner doctrine card;
- deterministic plan constraints;
- scheduler limits;
- worker routing rules;
- action policy index;
- verification contract;
- authority-role bindings;
- adherence metrics.

Never send the full organization policy to every model. Give each participant the minimum projection required for its role.

## Runtime changes

- communication verbosity: next message;
- reduced parallelism: stop leasing new tasks;
- capability revocation: immediate, pending actions invalidated;
- topology/PR shape: new tasks or explicit replan checkpoint;
- authority changes: reconcile and surface drift;
- memory retention: apply immediately and schedule deletion.

Material changes create a `doctrine.changed` event and invalidate any approval whose assumptions no longer hold.

The high-assurance overlay denies every `discord.presence.*` action at the
profile layer. Presence endpoints return 403 without invoking a transport while
that overlay is active.

## Connector-neutral policy

Connectors are an open, MCP-first ecosystem. Doctrine never requires a vendor noun. Each connector action declares one risk class:

| Risk class           | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `read`               | observes state without changing it                          |
| `narrative-write`    | adds attributed, reversible, non-authoritative conversation |
| `reversible-write`   | changes state with a reliable compensating operation        |
| `irreversible-write` | changes state that cannot be reliably restored              |
| `publish-external`   | sends content or artifacts outside the local trust boundary |
| `destructive`        | deletes, destroys, or materially damages state              |

The preset supplies the default policy for each class. A specific action such as a provider's PR operation may override that class posture, but it cannot weaken the invariant floor. An action from a never-before-seen connector is evaluated from its declared class; an unclassified unknown action is denied.

The capability exchange accepts the same classified action request. The connector adapter registers authenticated tool metadata with the doctrine classifier, which returns an opaque in-process classification for the policy decision. Worker-supplied class fields and model-written rationale are ignored.

### Worker MCP tool projection

The operator-authored MCP registry (`CLANKIE_MCP_REGISTRY`, `@clankie/mcp-registry`, [ADR 0027](adr/0027-mcp-worker-tool-projection.md)) is how workers gain direct connector tools. Every registered tool declares exactly one risk class above (never `narrative-write`) and is projected as the action `mcp.<server>.<tool>` through the compiled profile at fleet build. Only an exact `allow` reaches a worker; `require_approval` and `deny` both withhold the tool because a worker cannot pause mid-tool for a human. Undeclared tools are never projected, preserving the unclassified-action denial. The provider-native web research actions `web.search` and `web.fetch` follow the same projection as read-class actions gating the Claude worker's built-in WebSearch/WebFetch on `research` tasks; the high-assurance overlay denies both exactly.

### Narrative tracker writes

`narrative-write` is a narrow connector-neutral whitelist, not the complement of privileged writes. Trusted connector metadata can classify only these normalized kinds:

- issue comments;
- agent-session thought, response, and elicitation activities;
- emoji reactions;
- Discord presence reply, react, unreact, send-message, and typing ([ADR 0024](adr/0024-discord-dual-plane-presence.md)).

The three ceremony presets allow this class without human approval. Every allow decision records its mission or ambient presence-session attribution plus correlation attribution and carries the configured rate/volume obligation. The trusted narrative evaluator enforces a fixed 60-second attribution window of at most 20 writes, 16,384 bytes per write, and 65,536 bytes in the window. Correlation rotation does not reset the attribution window.

Tracker assignment mirrors retain their existing reversible posture. Status transitions, priority edits, acceptance-criteria edits, and completion-state changes have exact `require_approval` policies backed by the invariant authority floor, so a lower layer cannot convert them to `allow`. A new tracker mutation that is not named by doctrine is denied even when connector metadata describes it as a generic reversible write. Tracker reads retain the ordinary `read` posture.

The policy package exposes the stable runtime seam as `createNarrativeWritePolicy(compiledDoctrine)`. The control plane retains one evaluator for the lifetime of the compiled profile and calls `decide({ request, classification, correlationId, content })` with the trusted event correlation ID and the exact rendered narrative content. Direct `decideAction` calls for `narrative-write` fail closed so a connector cannot omit the rate ledger. The tracker-connector/control-plane plumbing that supplies those two fields is an explicit dependency of VUH-801; it reuses this evaluator rather than implementing bridge-local whitelist or counter logic.

## Authority-role bindings

Authority is expressed as abstract roles first, then bound by the workspace or repository:

| Role                     | Example binding, not a requirement      |
| ------------------------ | --------------------------------------- |
| `product_intent`         | operator or a work-tracking connector   |
| `priority`               | operator or a work-tracking connector   |
| `acceptance_criteria`    | operator or a work-tracking connector   |
| `approved_design`        | repository asset or a design connector  |
| `implementation_state`   | local VCS or a code-host connector      |
| `test_state`             | local command results or a CI connector |
| `technical_decisions`    | repository ADRs                         |
| `active_execution_state` | local harness event store               |

Bindings name the source that owns each field; they do not copy one source over another. `rawdog` resolves every role to the operator or local state, so a mission can run with zero external connectors. `fine-control` expects explicit connector bindings for collaborative product, design, implementation, and test roles. Actual connector choices are workspace configuration, not preset requirements.

## Invariant floor

Every compiled profile keeps independent verification enabled and denies test-integrity weakening. Production deployment, `publish-external`, `destructive`, and tracker authority-mutation actions require human approval in every preset. A lower doctrine layer or vendor-specific override may become stricter, but never reduce this floor.

## Review finding adjudication

Before merge or integration, every reviewer or verifier finding has one
recorded adjudication in the pull-request thread or authoritative tracker:

- `fixed` — identifies the remediation and its evidence;
- `waived-with-reason` — states why the finding is consciously accepted and who
  made that decision; or
- `false-positive-with-evidence` — cites the counterevidence that invalidates
  the finding.

The implementer may supply a fix or counterevidence but never decides a waiver
against their own change. Waivers are decided by the lead or integration owner.
A blocking-severity finding is waivable only by the lead or human owner, never
by the implementer; the human owner may always waive the finding. A
`false-positive-with-evidence` closure requires recorded concurrence from the
finding's author or a lead who did not implement the change. These separation
rules apply when one principal occupies multiple roles. Adjudication does not
grant an action, loosen the invariant floor, or replace any required approval.

The lead or integration owner ensures every finding is identifiable and covered.
One sentence per finding is sufficient, and multiple sentences may be posted
together. Green checks, reviewer silence, or an unmentioned merge do not
adjudicate a finding. This section is the authoritative contract; review skills
project it into reviewer workflow.

## Persona and channel authority

Persona content (`soul.md`, skin packs, character assets) is model-controlled input. It shapes tone, voice, and presentation only. The doctrine compiler ignores it: persona can never loosen a permission, change routing or authority, reduce evidence requirements, or alter budgets. Persona content that instructs otherwise is treated as prompt injection.

Channels carry command-authority tiers, bound per workspace like authority roles:

- **Authenticated surfaces** (paired iOS/macOS device, authenticated TUI session): full command authority, including approvals.
- **Ambient channels** (Discord text/voice): steer, query, pause, and resume only. Approval of privileged or irreversible actions is never accepted from an ambient channel; the agent responds with a link to an authenticated surface.

Workspace bindings map channel identities (for example Discord roles) to command tiers. Voice input is treated as unauthenticated speech regardless of the speaking account.

## Interactive-environment capability projection

Environment phase, captain lane, an active runner lease, and the compiled
doctrine profile jointly determine the available capability set. Model text,
Minecraft chat, signs, books, plugins, and MCP metadata cannot widen it.

| Session phase | TUI / Discord surface            | Gameplay-lane surface                                             |
| ------------- | -------------------------------- | ----------------------------------------------------------------- |
| off / failed  | join, status                     | join, status                                                      |
| starting      | status, cancel join              | status, cancel join                                               |
| active        | status, steer, pause, disconnect | observe, bounded actions, action status/cancel, pause, disconnect |
| paused        | status, resume, disconnect       | status, resume, disconnect                                        |
| stopping      | status                           | status                                                            |

The projection is deny-by-default. A capability disappears immediately when
the phase or lease no longer permits it, and pending uses are invalidated.
Discord voice remains ambient authority: it can steer or stop an allowed
session but cannot approve remote joins, public chat, player combat, server
commands, or capability expansion. Emergency pause and disconnect bypass model
scheduling while still producing audited semantic events.

## Policy tests

Each profile needs executable examples:

```text
unknown destructive connector action → human approval required from risk class alone
production deploy and destructive shell → human approval required in every preset
rawdog authority roles + no connectors → operator/local bindings resolve
unclassified unknown action → denied
lower mission layer tries to allow org-denied action → still denied
narrative write without the trusted rate ledger → denied
whitelisted narrative write within its attribution window → allowed with mission-or-presence/correlation obligations
tracker authority mutation or unknown tracker mutation → approval required or denied
```

## Product controls

Expose seven coherent macro controls—initiative, autonomy, change granularity, parallelism, assurance, visibility, and economy—then show their exact expansion. Hard permissions are never silently changed by a slider.
