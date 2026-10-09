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

## Command-picker presentation batch

This is the next clear landable cut among the reviewed candidates, not a claim
that the remaining inventory has been exhausted. Four files lose 209 test lines.

| File under `apps/tui/test/` | Cut                                                                                                                      | Keep reason                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autocomplete.test.ts`      | Preview colors, spacer/description copy, outline glyph and full ranked-match arrays.                                     | Actual canonical selection, alias collision and Kitty release regressions; argument/skill completion boundaries, width, row budgets, dismissal and keyboard submit/cancel.                     |
| `interactive-flow.test.ts`  | Outline and hint copy, status-row alignment/color and current-value labels.                                              | Secret masking, multiline input, width, filtering, selected/current value submission, duplicate-title regression, right/left arrow and close behavior.                                         |
| `provider-commands.test.ts` | Fixed auth-status table, default slot labels, model-order helper snapshot, setup labels/order and readiness-footer copy. | Credential redaction/broker storage, hosted approval refusal, real provider/model/effort persistence, endpoint fallback, restart intent and authoritative cross-face config changes.           |
| `shell-assembly.test.ts`    | Default-state constructor snapshot, pending/picker/result copy and duplicated ten-line tool collapse assertions.         | Prompt preservation and uncertain delivery, steer/queue and pasted input, streamed words, scoped conversation/fresh-context/close handling, side transcript restoration and server interrupts. |

The one source edit is **export-only, no behaviour change**: `newestFirst` loses
an export used only by the deleted ordering snapshot. The implementation body
and its internal model-picker caller stay identical. `readinessFooter` remains
exported for its real entrypoint consumer. No exemptions or replacement
implementation snapshots are added. Native render goldens, actual startup frames
and guided-setup integration tests stay unchanged.

[Batch evidence](../testing/2026-10-09-command-picker-test-pruning/README.md)
records LOC, before/after gate wall time, selection and their comparison limits.

## Menu presentation and duplicate-helper batch

Eight mixed TUI files keep their behavior and boundary coverage while shedding
menu titles, status/hint copy, presentation order and duplicate helper assertions.
The [batch review](../testing/2026-10-09-menu-test-pruning/README.md) records each
cut and keep reason. No integration, golden or contract case is removed.

`external-activity.test.ts` retains expanded payload content;
`machines-menu.test.ts` retains discovered transport and command dispatch,
default-session protection, grants, reconnect and refusal;
`product-navigation.test.ts` retains exact membership and selected identity,
without asserting picker order; `settings-menus.test.ts` retains real persistence;
`setup-commands.test.ts` retains readiness, cancellation, draft and command routing;
`voice-commands.test.ts` retains actual wizard/API/broker integration and marker
redaction; `persona-commands.test.ts` retains defaults, alias recovery and stale
write refusal; `project-menu.test.ts` retains its revision-bearing API integration.

The deleted `describeVoice` helper case asserted labels without supplying a secret
marker; actual wizard redaction remains covered at the API/settings boundary.
Its sole test-consumer export becomes private with its body and runtime caller
unchanged: **export-only, no behaviour change**, under the existing lead ruling.

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

All 28 files in `packages/protocol/test/*.test.ts` were reviewed and retained.
They prove published producer/consumer schemas, old-client response compatibility,
immutable owner/occupant/incarnation correlation, delivery uncertainty, private
push and voice data boundaries, gateway route/header allowlists, real ingress/wake
cryptographic binding, bounded terminal bytes and lossless replay/recovery. Actual
`pmset` input goldens and the node-free React Native import contract stay.

Three mixed protocol files have later incidental-assertion candidates, without
any changes in this batch: `app-telemetry.test.ts` pins the exact `["zod"]` import
array; `host-power.test.ts` pins advice-copy fragments; `protocol.test.ts` pins role
array order and helper-generated appearance diversity. Their privacy, wire,
cryptographic, compatibility and data-preservation coverage stays.

The lifecycle tab-name and SSH settings-race regressions named by the assignment
remain protected. No evaluator, tldraw, skin-manifest, Swift-deduplication or ops
mockup cleanup is included here; those VUH-1897 items remain unassigned.

Further full-file reviews in this batch retain these files unchanged:

- `packages/settings/test/settings.test.ts`: secret/input/HTTPS/consent boundaries,
  execution-grant migration, private file mode, concurrent-write preservation,
  explicit environment precedence and MCP deny-by-default.
- Under `apps/tui/test/`, `voice-commands.test.ts`, `desktop.test.ts`,
  `settings-menus.test.ts`, `project-menu.test.ts`, `owner-command-layer.test.ts`
  and `host-power-surfaces.test.ts`: real settings/API writes, preserved owner
  state, credential separation, stale-draft refusal and honest native failures.
- Under `apps/tui/test/`, `seat-context-selection.test.ts`,
  `linear-follow-status.test.ts`, `stance-command.test.ts`, `file-command.test.ts`
  and `agents-command.test.ts`: exact conversation/native identity, scoped
  bearers, read-only/redacted status, bounded claims, named artifact publication
  and request refusal before external calls. Their request arrays are contracts.
- Under `apps/tui/test/`, `catalog-watch.test.ts`, `skill-catalog.test.ts`,
  `skills-command.test.ts`, `claude-tool-catalog.test.ts` and
  `setup-flow-integration.test.ts`: native discovery, consumer agreement,
  preserved failed-read state, real subprocess/HTTP catalog evidence and guided
  setup integration. `face-bash.test.ts` keeps real subprocess output, bounds,
  cancellation and failure propagation.
- Under `apps/clankie/test/`, `captain-render-notice.test.ts` and
  `operator-tool-detail.test.ts`: room/private-memory scope, honest render failure,
  secret redaction, bounded native detail and exact-only invocable skills.
  `packages/discord-presence-core/test/voice-tone-text.test.ts` keeps arbitrary
  stream-split behavior and withholding of malformed or partial voice directions.

Further read-only reviews retain these files unchanged:

- `interactive-environment`: `interactive-environment.test.ts`, `emulator.test.ts`:
  published Discord/GBA/environment schemas, frozen fixtures, credential/telemetry
  refusal, transport authority and bounded/versioned leases.
- `play`: `free-play-mind-prompt.test.ts`, `free-play-character.test.ts`,
  `play-story.test.ts`, `free-play-mind-timeout.test.ts`, `free-play-voice.test.ts`:
  real AI SDK prompt validation, live invalid-prompt and drained-stream wedge
  regressions, cold-start/decoder evidence, bounded structured output and
  journal/story identity without inner-monologue disclosure.
- `apps/clankie`: `captain-room-guidance.test.ts`, `persona-caption.test.ts`,
  `captain-loadout-tools.test.ts`: async one-use private guidance, separate room
  captures, real art-file captions, role separation and body-specific tool exposure.
- `apps/tui`: `services.test.ts`, `claude-plugin.test.ts`, `codex-plugin.test.ts`,
  `discord-room-view.test.ts`, `status-connection.test.ts`,
  `linear-follow-status.test.ts`, `herdr-roster.test.ts`, `next-step.test.ts`:
  real owned-process lifecycle, native hook trust and CLI consumer wiring, honest
  pending deliveries, redacted read-only wake state, native fleet cursors/identity
  and canonical recovery commands. These arrays describe consumer wiring.
- `discord-presence-core`: `addresses-character.test.ts`,
  `body-voice-lease.test.ts`, `body-voice-reconcile.test.ts`,
  `presence-grant.test.ts`, `voice-consent.test.ts`, `voice-control.test.ts`,
  `voice-address.test.ts`, `voice-audio.test.ts`, `voice-room-evidence.test.ts`,
  `shutdown.test.ts`, `discord-rest.test.ts`, `minecraft-login-code.test.ts`,
  `transcript-store.test.ts`, `room-text.test.ts`, `receipt-store.test.ts`,
  `presence-session.test.ts`: consent/account/guild and lease fences, exact native
  termination, HTTP/URL/mention contracts, guarded secret-bearing DM delivery,
  PCM/WAV boundaries and real room-tone regression, private append/tail/symlink
  modes, content-free receipts and synchronous publication-loss fencing.
- Mixed later candidates stay unchanged: `check-report.test.ts` under
  `discord-presence-core` keeps the JSON CLI output contract; its human table
  alignment is a future presentation cut. `captain-model-card.test.ts` under
  `apps/clankie` keeps per-run refresh and unresolved-model behavior; its exact
  sentence-formatting case is a future incidental cut.

Further retained consumer contracts: `elevenlabs-tts.test.ts`,
`voice-ingress.test.ts` and `voice-floor.test.ts` under `discord-presence-core`
keep provider WebSocket/PCM transport, bounded secret-safe failures, public
speech-rate caps, speaker attribution and withholding ambient approval payloads.
`play-voice/test/listener.test.ts` keeps real WebSocket bearer/route/size behavior,
Unicode-safe attributed words, no absent-client replay and EADDRINUSE recovery.
`model-provider/test/openai-codex.test.ts` keeps the real local OAuth callback,
state/PKCE binding, device polling, broker refresh races and revoked credentials.

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
