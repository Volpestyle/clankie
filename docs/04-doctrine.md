# Orchestration doctrine

Doctrine is a versioned operating contract, not a prompt-only preference sheet.

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
- field-level source authority;
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
- authority map;
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

## Policy tests

Each profile needs executable examples:

```text
low-risk verified docs PR + one human approval → merge allowed/approval as configured
high-risk auth path → human merge required
production deploy → denied in community default
unknown action → denied
lower mission layer tries to allow org-denied action → still denied
```

## Product controls

Expose six coherent macro controls—initiative, autonomy, change granularity, parallelism, assurance, visibility, and economy—then show their exact expansion. Hard permissions are never silently changed by a slider.
