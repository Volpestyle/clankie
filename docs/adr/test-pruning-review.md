# Reviewed test inventory for ADR 0221

This is the ongoing review for [VUH-1925](https://linear.app/vuhlp/issue/VUH-1925),
under [ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md). The inventory
is not complete. Files without a recorded review remain unchanged. In particular,
plain `.test.ts` names do not establish that a test is a unit test: several exercise
real HTTP, filesystem, native executable and producer/consumer boundaries.

Keep trust boundaries, published contracts, regressions grounded in actual bugs,
and all E2E, integration and golden tiers. Exact values are useful when they are
the contract or retained real evidence; they are incidental when they merely
repeat today's implementation or presentation choice.

## First batch: Linear test data

The provider SDL shrank from 52,706 to 2,528 lines without deleting assertions.
The [schema review and measurements](../testing/2026-10-09-linear-schema-subset/README.md)
record the retained upstream types and signatures. Keep all five consumer files:

| File under `apps/clankie/test/`                        | Keep reason                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `linear-api-tracker.test.ts`                           | Provider documents, credential renewal/revocation, redaction and pagination contracts. |
| `linear-graphql.integration.test.ts`                   | Lane authority, destructive confirmation and request admission across localhost HTTP.  |
| `linear-request-budget.integration.test.ts`            | Quotas, actor isolation and reserved write/API/MCP accounting.                         |
| `linear-request-budget-autonomous.integration.test.ts` | Integration tier; its existing skip remains, and is not an executed pass.              |
| `worker-call-receipts.integration.test.ts`             | Durable uncertain receipts, replay refusal and authority fences.                       |

## TUI presentation batch

Retain these five mixed files, removing only the reviewed incidental cases:

| File under `apps/tui/test/` | Cut                                                                                                                   | Keep reason                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `banner.test.ts`            | Mascot glyph, palette RGB, row count, gutter, exact ASCII art, fixed condensed layout and padding snapshots.          | Actual component width, hidden state, non-TTY/`NO_COLOR`/`COLORTERM` behavior, escape-free color opt-out and ASCII-only fallback.                   |
| `footer.test.ts`            | Token abbreviation strings, internal warning levels, exact context copy, extras separators and fixed row composition. | Actual terminal width across wrapped rows and very narrow output.                                                                                   |
| `connections-menu.test.ts`  | Relative-age/path/transcript formatting helper snapshots and exact ordered hub-option arrays.                         | Native resume dispatch, refused reads, durable errors and original-conversation reuse without a new process.                                        |
| `herdr-menu.test.ts`        | Option order and exact labels.                                                                                        | Save before restart, cancellation, bundled/disabled configuration and retained session selection.                                                   |
| `tool-render.test.ts`       | Refusal pretty-print line count, fixed ten-line helper arrays and flattened argument copy.                            | Real captured Linear envelope and its formerly ineffective collapse regression; lossless non-envelope/text handling and Pi/MCP renderer delegation. |

Do not re-add these deleted kinds as unit snapshots. A mascot, palette, separator,
menu order, padding or abbreviation can change without breaking a published
contract. Prove intended presentation with inspected output or real evidence.
Renderer delegation and safe session reuse remain contracts even when exercised
with a controlled transport.

The first after-cut gate found six helper functions and one type exported solely
for the removed snapshots. The lead approved making them private to their two
implementation modules: **export-only, no behaviour change**. Their bodies and
internal runtime callers are unchanged. Knip remains active; no replacement
snapshots or dead-code exemptions are added. The same approval covers future
helpers that become unexported or dead after their sole test consumer is removed;
any behaviour change needs the lead's decision.

These source visibility changes broaden native Vitest dependency selection, so
gate time must not be presented as a matched speedup against the five-file
baseline.

Keep `native-tool-render-integration.test.ts` unchanged: native JSONL passes through
the actual parser, shell and Pi components, including retained VUH-1661 goldens,
malformed output, running sessions, empty results and collapse/expand behavior.
Keep `fresh-page.test.ts` unchanged: real shell frames exercise restored history
and startup ordering. Neither file is replaced by helper snapshots.

The [batch evidence](../testing/2026-10-09-tui-test-pruning/README.md) records
line counts, gate selection and retained failed runs.

## Other reviewed files retained

These reviews authorize no deletion in the listed files. Mixed files can receive
a later case-level review; their boundary coverage must survive it.

| Package and files under its `test/` directory                                                                                                                       | Keep reason                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-hosts`: `hosts.test.ts`, `pi-roots.test.ts`                                                                                                                  | UTF-8 byte ranges, native profile selection, SSH injection refusal, shell quoting, symlink/path containment and malformed remote responses.                                      |
| `vec3`: `vec3.test.ts`                                                                                                                                              | Existing Minecraft CommonJS/pathfinder consumer contract, mutation versus copying and zero-vector normalization.                                                                 |
| `work-items`: `backends.test.ts`, `convention.test.ts`, `format.test.ts`, `linear-pagination.test.ts`                                                               | Tracker/CLI/provider contracts, owner-text preservation, fenced Markdown, token redaction, origin-only pagination, bounded continuation and refusal to guess competing trackers. |
| `model-registry`: `model-registry.test.ts`, `hire-model.test.ts`                                                                                                    | Published price/catalog inputs, disk cache and environment overrides, malformed/forward-compatible catalog data and refusal of retired/wrong-harness hires.                      |
| `observability`: `body-telemetry.test.ts`, `hosted-body-telemetry.test.ts`, `body-telemetry-shipper.test.ts`, `support-audit-http.test.ts`, `observability.test.ts` | Secret/prompt redaction, tenant stamping, signed requests, durable retry cursors, mandatory support audit and real shell/HTTP producers.                                         |
| `persona-images`: `persona-images.test.ts`, `video.test.ts`                                                                                                         | Real art/FFmpeg producers, bounded decoded content, symlink refusal, cache recovery and explicit image-data versus instruction priority.                                         |
| `interactive-environment`: `activity-observation.test.ts`, `discord-transport.test.ts`                                                                              | Published observation/presence schemas, bounded data, room membership and body-swap address compatibility.                                                                       |
| `rendered-surface-client`: `activity-frame-sink.test.ts`                                                                                                            | Producer bearer/wire contract, stale frame/audio refusal, latest-status replay and explicit-close reconnect behavior.                                                            |
| `play-voice`: `client.test.ts`                                                                                                                                      | Bearer and bounded narration/utterance contracts, unreachable refusal, room-state reset and malformed wire rejection.                                                            |
| `apps/clankie`: `captain-lane-prompt.test.ts`                                                                                                                       | Authenticated HTTP prompt/card reads stay inside the bearer's lane; unauthenticated or cross-lane access never assembles private notes.                                          |

Further reviewed files retained:

| Package and files under its `test/` directory                                                   | Keep reason                                                                                                          |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `api-client`: `api-client.test.ts`, `gateway-encryption.test.ts`                                | Bearer/lane/live-session API contracts, delivery-ID polling and encrypted refusal without replaying uncertain sends. |
| `settings`: `attachments.test.ts`                                                               | Actual attachment-path producer/reader regression, including blank overrides.                                        |
| `settings`: `codex-rate-limits.test.ts`                                                         | Read-only RPC/profile isolation, bounded owned-child cleanup, and no automatic login or hook trust acceptance.       |
| `settings`: `project-worktrees.test.ts`, `project-enrollment.test.ts`, `settings-fence.test.ts` | Approved workspace namespace, actual Git identity, path containment and settings-generation authority races.         |
| `settings`: `minecraft-settings.test.ts`, `linear-wake-migration.test.ts`                       | Approved destinations and play budgets; owner identity, edited wake rules and malformed persisted data preservation. |
| `settings`: `skill-roots.test.ts`, `bundled-skills.test.ts`                                     | Shipped/workspace/personal precedence and plugin projection contracts; retired names do not reappear.                |

| Package and files under its `test/` directory                                                                                                                                                                                                                                                                                                                                                                                                                                | Keep reason                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credential-broker`: `account-credential.test.ts`, `credential-broker.test.ts`, `credential-store.test.ts`, `linear-app.test.ts`, `linear-oauth.test.ts`, `activity-producer-credential.test.ts`, `captain-credential.test.ts`, `discord-user-session-provider.test.ts`, `operator-credential.test.ts`, `play-voice-credential.test.ts`, `provider-bearer.test.ts`, `public-gateway-credential.test.ts`, `discord-bot-provider.test.ts`, `discord-bridge-credential.test.ts` | Credential and lane boundaries, secret redaction, token rotation and lost-reply recovery, sign-in versus retryable refusal, corrupt-data preservation, private file modes and real independent-process refresh races.                                  |
| `settings`: `agent-hosts.test.ts`, `codex-accounts.test.ts`, `persona.test.ts`, `store-isolation.test.ts`, `linear-follow.test.ts`, `linear-wake.test.ts`, `machines.test.ts`, `projects.test.ts`                                                                                                                                                                                                                                                                            | Host injection refusal, credential-profile isolation, owner-authored persona preservation and hallucination regression, real process isolation, wake author identities, approved machine/project grants and revocation without migration resurrection. |

| Package and files under its `test/` directory                                                                                                                                                                       | Keep reason                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `interactive-environment`: `rendered-surface.test.ts`                                                                                                                                                               | Published overlay v1/v2 wire compatibility, honest stale-producer normalization and incompatible version refusal.                                                                                                                    |
| `media-connector`: `media-connector.test.ts`                                                                                                                                                                        | Provider schemas and credential transport, exact persisted/hash artifacts, edit/generation routing, video-origin/status refusal and reference preservation.                                                                          |
| `model-provider`: `subscription-policy.test.ts`, `readiness.test.ts`, `routing.test.ts`, `local-endpoint.test.ts`, `anthropic-configured-model.test.ts`, `xai-configured-model.test.ts`, `configured-model.test.ts` | Hosted subscription approval and credential boundaries, routing money/escalation policy and VUH-1391 regression; persisted endpoint configuration, SDK credential separation and actual Astra reasoning-effort transport regression. |

The lifecycle tab-name and SSH settings-race regressions named by the assignment
remain protected. No evaluator, tldraw, skin-manifest, Swift-deduplication or ops
mockup cleanup is included here; those VUH-1897 items remain unassigned.

## Remaining inventory

The read-only candidate scan also includes native test filenames and Rust files
with inline test attributes. Whole Rust source-file lines are not test-only LOC.
It records file hashes and repository revisions in the worker's ignored
`.local/vuh-1925/inventory-candidates.json`; unreviewed status is explicit. This
scan is a discovery aid, not a finished classification or a deletion rule.

Private app and hosted-service reviews stay in their own repositories or private
issue evidence. They do not publish private implementation details here. No
private tests have been deleted by this batch. Evaluation fixtures are outside
this pruning and remain manual-only.
