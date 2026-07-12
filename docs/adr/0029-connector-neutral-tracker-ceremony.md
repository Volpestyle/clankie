# ADR 0029: Connector-neutral tracker ceremony and human-attention contract

Status: accepted (VUH-845).

## Context

Captains need a single portable definition of impact-led ticket drafting and human
escalation that every workspace and tracker connector can share. Without a
protocol- and doctrine-level contract, prompts invent divergent shapes, and
behavior cannot be validated or audited before connector delivery.

Ceremony presets already encode _integration_ style (`externalConnectors`,
`integrationFlow`) but not tracker drafting or human-attention defaults.
Overlays deliberately strip `ceremony` and `authority` so assurance tightening
cannot rewrite identity or binding ceremony ([docs/04-doctrine.md](../04-doctrine.md)).

## Decision

### Protocol owns connector-neutral wire shapes

`packages/protocol` defines additive schemas:

- `ProductImpact` / `TrackerIssueDraft` — impact-led issue drafts with stable IDs,
  correlation, timestamps, and authority impact.
- `HumanAttentionRequest` / `HumanAttentionResponse` — semantic `targetRole`,
  request kind, actionable ask, blocking state, notification _surfaces_, tracker
  correlation, and timestamps.

These schemas name **roles and surfaces**, not providers, principals, labels,
assignments, emails, or mention syntax. Connectors (Linear, GitHub, …) bind
opaque `externalRef` values only at delivery time (VUH-846+).

### Doctrine owns customizable ceremony defaults

`ceremony.tracker` is an optional structured block on base/non-overlay layers.
When omitted, `defaultTrackerCeremony` / `projectCaptainCeremony` derive
deterministic defaults from `externalConnectors` + `integrationFlow` so existing
presets keep compiling without shape churn.

#### Decision / defaults table (five VUH-844 ceremony controls)

| Control                         | Field                                         | Default when unset                                     |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Product impact heading          | `issueDraft.heading`                          | `Product impact`                                       |
| Section placement               | `issueDraft.sectionPlacement`                 | `first`                                                |
| Concise maximum length          | `issueDraft.maxSummarySentences`              | `3` (sentences)                                        |
| Direct-notification mode        | `humanAttention.directNotification`           | `required` (`required` \| `best_effort` \| `disabled`) |
| Wait for authoritative response | `humanAttention.waitForAuthoritativeResponse` | `true` (blocking attention gates wait)                 |

Also retained: `issueDraft.enabled` / `requireProductImpact`, and human-attention role,
request kind, notify-when-blocking, surfaces, and urgency defaults keyed by ceremony style.

**Overlays still cannot set ceremony** (`DoctrineOverlaySchema` uses
`ceremony: z.never().optional()`; `applyLayer` drops ceremony). Tracker ceremony
customization is therefore:

| Layer kind                        | Ceremony effect                                                               |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Base preset / non-overlay partial | May set or deep-merge `ceremony.tracker`                                      |
| Overlay                           | Ceremony ignored; only tightening fields apply                                |
| Invariant floor                   | `independentVerifier` remains required; higher-scope `deny` actions preserved |

### Captain projection is pure and connector-free

`projectCaptainCeremony(compiled)` returns a concise deterministic projection
including profile id/hash, connector/integration ceremony, **all five controls
above**, remaining issue-draft/human-attention defaults, and the
independent-verifier flag. Captains exercise it without opening a tracker
connector or session. VUH-846 validates and delivers against this projection
without guessing ceremony knobs.

### Protocol boundary refinements

Portable schemas reject whitespace-only authored text (`actionableAsk`,
`rationale`, product-impact `summary`, draft title/objective), require
`expiresAt` strictly after `createdAt` when set, and reject conflicting
top-level vs nested `trackerRef.correlationId` when both are present.

## Alternatives considered

1. **Prompt-only ceremony** — rejected: not schema-validatable, drifts across captains.
2. **Provider-specific protocol fields** (e.g. assignee email, label names) — rejected:
   breaks connector neutrality and couples protocol to one tracker.
3. **Allow overlays to rewrite ceremony** — rejected: would let assurance overlays
   change integration identity; contradicts the preset/overlay split.
4. **Runtime-only defaults in captain-eve** — rejected for this slice: defaults must
   compile with doctrine and be testable without captain wiring (VUH-846+).

## Provider-binding boundary

| Layer                                            | Responsibility                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Protocol                                         | Validate semantic drafts and attention messages                          |
| Doctrine                                         | Compile ceremony defaults and captain projection                         |
| Tracker connector / control plane (out of scope) | Map roles → principals, surfaces → delivery channels, bind `externalRef` |
| Captain runtime (out of scope)                   | Emit validated drafts/requests; await responses                          |

Models never hold tracker credentials. Privileged mutations remain policy-gated
actions (`tracker.*`) as today.

## Webhook / session limitation

This ADR does **not** define tracker webhooks, OAuth sessions, or durable attention
inboxes. Correlation IDs on protocol messages are sufficient for later delivery
receipts; session attachment and webhook verification remain connector concerns
(VUH-846+). Human-attention responses are protocol messages, not browser sessions.

## Consequences

- Focused protocol/doctrine tests cover valid/invalid shapes, defaults, overrides,
  overlay rejection, floor preservation, and projection determinism.
- Existing ceremony equality fixtures remain stable when `ceremony.tracker` is omitted.
- Downstream VUH-846 implements delivery and correlation against these frozen shapes.
