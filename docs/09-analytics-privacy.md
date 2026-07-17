# Product analytics and privacy

## Principles

- analytics is separate from operational/audit telemetry;
- user content, source code, prompts, terminal output, voice audio, and secrets are excluded;
- runner worker-transcript entries are operational projections and are excluded from analytics;
- local-only installations work with analytics disabled;
- events are documented, versioned, consent-gated, and deletion-aware;
- measure outcomes and friction, not surveillance.

## Safe event taxonomy

Examples:

```text
mission_created
plan_approved
worker_started
worker_replaced
verification_failed
recovery_succeeded
approval_requested
approval_decided
terminal_input_started
terminal_input_ended
doctrine_changed
garden_command_used
evaluation_completed
```

Allowed properties include coarse counts, durations, profile/preset IDs, harness category, task kind, result status, app platform/version, and bucketed cost. Repository names, issue text, filenames, command lines, model output, user names, and Discord content are not analytics properties.

## North-star and guardrail metrics

North-star candidate: **verified missions accepted by a human without rework**, per active workspace.

Guardrails:

- defect escape rate;
- critical policy violations;
- human interventions per mission;
- recovery success;
- time to attention/approval;
- cost per accepted mission;
- direct terminal input frequency and duration;
- user-reported trust/satisfaction;
- opt-out and deletion success.

## Experiments

Use feature flags for garden interactions, doctrine presets, routing, and notification behavior. Never experiment with hard security permissions, retention, or hidden provider credential routing without explicit enrollment.

`@clankie/analytics` provides a provider-neutral, consent-aware interface. A hosted product may implement PostHog or another backend; the community edition defaults to a no-op sink.
