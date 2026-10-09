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

## Service presentation helpers

Two mixed files lose 24 test lines and one case. Product code, exports and
fixtures are unchanged.

| File under `apps/clankie/test/` | Cut                                                                  | Keep reason                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captain-model-card.test.ts`    | Exact model-card sentences, token abbreviations and input-list copy. | Per-run resolution refresh, original system prompt and honest unavailable-model behavior.                                                                                                                     |
| `play-execution-shared.test.ts` | Exact ordered room-event text snapshot.                              | Overlay length cap and blank-event omission. The retained `play-voice.test.ts` runtime cases exercise the authored thought, observed outcome, goal and next intent across the actual play/voice/journal seam. |

The room-event fields remain behavior covered by that runtime file; only the
helper's incidental field order and line layout disappear. The model-card text
can change without invalidating model selection or prompt refresh.

Additional full-file reviews retain `captain-memory.test.ts`,
`captain-model.test.ts`, `personas.test.ts`, `runtime-health.test.ts`,
`captain-native-subagents.test.ts`, `codex-accounts.test.ts`,
`captain-body-identity.test.ts`, `captain-browser-tools.test.ts`,
`browser-authority.test.ts`, `system-authority.test.ts`, `desktop.test.ts`,
`operator-auth.test.ts`, `runtime-terminals.test.ts` and
`runtime-connections.test.ts`. They guard lane-scoped private memory and file
publication, broker preservation and serialized credential rotation, durable
owner identities and exact account homes, bounded public boot identity,
transcript/presence consumer agreement, original turn authority and revocation,
browser shell grants, room audience grants, owner quiet hours, HTTP credential
revocation, pinned terminal routing and runtime/workspace approval. Exact
request arrays and native identities in these files enforce contracts, rather
than presentation order. The empty-memory label is explicitly documented in
`docs/cli.md`, so its case remains. No E2E, integration or golden case is removed.

The [batch measurements](../testing/2026-10-09-service-helper-test-pruning/README.md)
record counts and the before gate. Final gate output and timings are retained
with the batch's issue evidence; the all-repository inventory remains incomplete.

On resumption, eleven additional full-file reviews keep `presence-service`,
`memory-capacity-api`, `lead-coding-helper`, `voice-transcripts`,
`discord-captain-actions`, `discord-tool-progress`, `discord-turn-trail`,
`discord-sender-standing`, `herdr-head-seat`, `herdr-parent-edges` and
`pi-native-capability` under `apps/clankie/test/`. They protect real captain/API
projection, the historical memory quota bug, bounded no-follow filesystem and
clean-shell operations, private retained transcript access, persisted dispatch
guards after restart, content-free progress, one-shot native turn provenance,
verified owner/grant separation, native head identity, corrupt-cache recovery
and inode/hash-bound native capability lifetime. Ordinary filenames do not
make these producer/consumer integrations removable unit coverage. No test is
removed from these files and the helper fixtures do not run evaluations.

## Further boundary review after VUH-1948

These 50 additional files are retained. Reviews use the file bytes on
`3ef50411d`, based on `6f7e23aa`; no deletion is authorized by this list.
Rust whole-file line counts include production code, not only tests.

- `apps/tui/test/linear-publishing-command.test.ts`: Keep published CLI/provider request decoding, fail-closed refused/uncertain/malformed envelopes and malformed-input no-call boundary.
- `apps/tui/test/workspace.test.ts`: Keep real filesystem checkout/root/path resolution, non-directory refusal and conversation workspace scope contract.
- `apps/discord-bridge/test/subcommand-authority.test.ts`: Keep Discord command authority, owner-only settings and revocable voice-consent fences. Source-wiring assertions remain because full dispatch duplication is not established; no speculative cuts.
- `apps/tui/test/work-command.test.ts`: Keep published work CLI request mapping, criteria/status/owner/evidence preservation and malformed argument refusal.
- `apps/discord-user-session/test/stream-discovery.test.ts`: Keep Discord stream producer/consumer opcodes, stream keys, credential events, DAVE channel identity and ended-stream cleanup.
- `apps/tui/test/pair-routes.test.ts`: Keep pairing CLI reachability disclosure and JSON route contract across gateway/direct/no-route offers, including App Store plain-HTTP refusal.
- `apps/clankie/test/project-worktree-membership.test.ts`: Keep native linked-worktree admission and cwd/process/authority/settings race refusal across Git observation.
- `apps/tui/test/support-http.test.ts`: Keep real CLI/console/HTTP support-grant create/list/pair/revoke integration, expiration bound and invalid scope refusal.
- `apps/clankie/test/gmail-mcp-canary.test.ts`: Keep credentialless no-network refusal and explicitly opt-in real broker/Google MCP canary. No live canary run authorized or performed.
- `apps/clankie/test/codex-seat.test.ts`: Keep native foreground/open-file session resolution, exact parent preference versus child rollout and absent/replaced native session behavior.
- `apps/clankie/test/hosted-wake-key.test.ts`: Keep real device-pairing HTTP authentication/schema/revocation boundary, local revocation through hosted cleanup failure and self-hosted route absence.
- `apps/clankie/test/operator-conversation-workspace.test.ts`: Keep actual conversation-store turn workspace/native seat/run correlation and absolute-existing-directory refusal.
- `apps/clankie/test/http-journey.test.ts`: Keep real HTTP/restart integration, pairing-code secrecy and operator-only offer refusal without event-log mutation.
- `apps/clankie/test/local-fleet-discovery.test.ts`: Keep private/production filesystem isolation across publication/cleanup failures, actual native discovery reader and authenticated link boundary.
- `apps/tui/test/harness-enable-idempotency.test.ts`: Keep captured native enable result regression, exact profile/source and native error proof, retarget/race/wrong-profile refusal.
- `apps/clankie/test/inbound-seat-binding.test.ts`: Keep fresh native session identity before receipt/POST acceptance, alias/replacement refusal and no legacy unbound delivery.
- `apps/clankie/test/work-items-linear-results.test.ts`: Keep actual MCP host/work service integration, lossless large JSON and explicit oversized UTF-8 byte refusal without truncation.
- `apps/clankie/test/voice-receipt-activity.test.ts`: Keep real JSONL receipt consumer integration, open/closed room stay correlation and spoken/suppressed/token accounting.
- `apps/clankie/test/codex-catalog-refresh.test.ts`: Keep real filesystem notification coordinator integration, bounded failures/no duplicate native mutation and private config symlink/home refusal.
- `apps/clankie/test/project-routes.test.ts`: Keep HTTP settings mutation trust boundary, explicit workspace/revision and authority races, tracker binding protection and unrelated data preservation.
- `apps/tui/test/project-settings-cli.test.ts`: Keep CLI operator-bearer/revision request contracts, conflict no-retry and exact seat/occupant membership without injected project.
- `apps/clankie/test/discord-durable-room.test.ts`: Keep untrusted backlog isolation versus carried history, durable room/native voice session compatibility and silence sentinel streaming contract.
- `apps/clankie/test/captain-turn-metrics-api.test.ts`: Keep operator-only bounded metrics API, no transcript disclosure and unknown legacy execution/usage without invented token accounting.
- `apps/clankie/test/seat-ledger.test.ts`: Keep real durable file/restart accounting, seat/day isolation and honest observed run outcomes; disappeared panes never become success.
- `apps/tui/test/seat-hook.test.ts`: Keep native hook CLI wire/auth/session correlation, actual transcript fallback and absent/unowned pane no-report boundary.
- `apps/clankie/test/hosted-device-security.test.ts`: Keep real filesystem key identity/private modes, rollback/session revocation and lost-response recovery, unreachable authority and symlink refusal.
- `apps/tui/test/metrics-cli.test.ts`: Keep documented CLI bounds/query/auth contracts and honest legacy unknowns; credentialless read never becomes anonymous network access.
- `apps/tui/test/project-onboarding-cli.test.ts`: Keep reviewed proposal/hash/incarnation/revision contract, uncertain no-retry and malformed no-dispatch; review never implicitly confirms.
- `apps/vox/src/media_sink_wants.rs`: Keep Discord opcode 15 producer/consumer payload stream/quality/pixelCounts contract. Whole-file LOC includes production code, not test-only LOC.
- `apps/clankie/test/agent-sessions.test.ts`: Keep native transcript producer/consumer formats, bounded UTF-8 tails/cursors, replacement/partial-record lossless recovery and retargeted host cache isolation. No PC work executed.
- `apps/clankie/test/agent-work.test.ts`: Keep real SQLite/file/restart goal and assignment contracts, exact occupant persistence, legacy-client compatibility and read-only unsupported/remote store isolation.
- `apps/clankie/test/accounts.test.ts`: Keep real loopback OAuth/broker/HTTP integration, provider/account/consent/revocation/PKCE isolation and replay refusal, real subprocess stdout/events/telemetry credential redaction, hosted token separation.
- `apps/clankie/test/body-lease-router.test.ts`: Keep real durable lease mutual exclusion/recovery, grant/identity rechecks before effects, uncertain no-replay, explicit scoped wake/head routing and overlapping receipts.
- `apps/clankie/test/body-lease-routes.test.ts`: Keep authenticated HTTP writable conversation authority, scoped browser leases/refused close, actual-stop-before-release, stale/revoked token fences and explicit head designation.
- `apps/clankie/test/body-leases.test.ts`: Keep real durable exclusive lease/restart and abrupt-death lock recovery, stale/expired token fencing, uncertain effects and corrupt/unwritable-state fail-closed.
- `apps/clankie/test/herdr-runtime.test.ts`: Keep real socket ownership refusal/closure and real pane shell environment isolation, selected installed/bundled binary and harness-marker boundary.
- `apps/clankie/test/operator-conversation-input.test.ts`: Keep actual durable conversation queue/steer producer-consumer ordering and replay behavior for both owner and internal turns.
- `apps/discord-bridge/test/voice-presence.test.ts`: Keep Discord live-body authority/target/consent boundary, idempotent join and cross-guild leave refusal.
- `apps/clankie/test/channel-projection.test.ts`: Keep Discord webhook wire/room/thread/credential transport contract, mentions disabled, content bounds and honest provider refusals.
- `apps/clankie/test/fleet-membership-route.test.ts`: Keep authenticated HTTP/CLI membership integration, revoked-authority post-observation refusal and honest unavailable native card.
- `apps/clankie/test/herdr-session.test.ts`: Keep exact owner-selected external runtime versus service-owned runtime, launch environment isolation and absent/native observation fallback.
- `apps/clankie/test/linear-fleet-admission.test.ts`: Keep actual MCP/provider/HTTP write fences after asynchronous author attribution and credential/header selection; revoked fleet cannot dispatch.
- `apps/tui/test/telemetry-support-http.test.ts`: Keep real CLI/loopback metadata/signed transport integration, mandatory support audit independent of diagnostic consent.
- `apps/clankie/test/project-membership-latency.test.ts`: Keep native authority proof bounded-scan regression, two checkpoints and no cross-request stale process/cwd/failed observation reuse.
- `apps/tui/test/restart.test.ts`: Keep delayed restart CLI/runtime contract: final complete answer versus partial/tool-use transcript, preserved service/Discord launch and harness environment isolation. No service restarted.
- `apps/tui/test/send-stdin.test.ts`: Keep CLI UTF-8 stream/newline preservation and duplicate/empty input no-dispatch boundary.
- `apps/clankie/test/lead-census.test.ts`: Keep fixture isolation from actual owner transcripts, native goals/work/subagents and ambient process access.
- `apps/tui/test/harness-profile-alias.test.ts`: Keep canonical profile/symlink/source-manager boundaries and post-consent/native/skill-build races; no unapproved alias retarget/update.
- `apps/clankie/test/connect-tools.test.ts`: Keep operator-only inbox trust boundary and sender-authored content untrusted marking without treating refusal as sender text.
- `apps/clankie/test/pokeagent-mmo-boundary.test.ts`: Keep published player versus world-host dependency/transport boundary; no duplicate socket host implementation.

## Discord helper presentation batch

Reviewed both complete test files, their product functions, real readiness/live-proof
CLI consumers and original changes (`71066d70c`, `f60806d86`) at main `3ef50411d`.
Neither deleted detail is a documented actual bug regression or machine contract.

- `packages/discord-presence-core/test/check-report.test.ts`: remove the human
  PASS/FAIL table snapshot of exact padding, title and remediation placement.
  Keep the JSON CLI payload case byte-identical: machine-readable output is a
  published consumer contract. The writer and all real consumers remain.
- `apps/clankie/test/discord-music.test.ts`: remove the exact authored sentence
  for an unreachable body. Keep `ok: false` refusal, selected live-body routing,
  author attribution and lossless provider replies; all three cases remain.

These two files shrink from 103 to 74 lines, five to four cases: 29 lines and
one case removed. No product code, exports, fixture or E2E/integration/golden
tier changed. The actual text writer is run and its output inspected alongside
the retained tests. [Measurements and evidence](../testing/2026-10-09-discord-helper-test-pruning/README.md)
record the baseline and landing gates; temporary baseline selectors are absent
from the committed files. Running subtotal: six unit-pruning batches, 688 lines
and 39 cases removed; fixture bulk remains separate. The inventory is incomplete.

Further full-file boundary reviews on the same main retain:

- `apps/clankie/test/minecraft-host-authority.test.ts`: Keep final conversation/individual grant versus guild-only authority, post-await revoke and synchronous stale identity dispatch fences.
- `apps/clankie/test/tracker-isolation.test.ts`: Keep real config/native subprocess boundary disabling inherited tracker connectors and listing failure fail-closed.
- `apps/clankie/test/remote-lead-delegations.test.ts`: Keep launch-secret exact host/pane/occupant/process lifetime proof, retained grant revoke/downgrade/unavailable/post-await refusal. Reviewed only; no remote machine operation.
- `apps/clankie/test/host-power.test.ts`: Keep real pmset-format producer/consumer schema and health API/CLI fresh opt-in, unknown/sleep-gap versus ordinary stall observation contracts.
- `apps/clankie/test/minecraft-destination.test.ts`: Keep DNS/IP/SRV pinning and exact approved public host/port trust boundary, mixed/nonunicast/failure refusal and endpoint redaction.
- `apps/clankie/test/minecraft-host-invite.test.ts`: Keep recipient/enrollment-bound ephemeral capability, revoke-before-dispatch, immutable origin/public credential redaction and private/invalid endpoint refusal. Mixed line-count/copy remains later incidental candidate.
- `apps/clankie/test/composer-catalog.test.ts`: Keep real skill roots/native harness catalog syntax and enabled-only plugin/schema quick-action validation shared across API/seat producers.
- `apps/clankie/test/email.test.ts`: Keep real credential/settings boundary and IMAP/SMTP/MIME consumer contract, absent credentials refuse. No live mail read/send.
- `apps/clankie/test/opencode-profiles.test.ts`: Keep real native SQLite/file/API source lifetime, original prepared identity/fresh proof and retarget/session/foreign machine refusal; metadata cannot launch.
- `apps/clankie/test/remote-herdr-transcript.test.ts`: Keep exact listed host/native session versus prefix/ambiguous/unlisted path boundary and lossless append/cache/concurrent producer reads. Reviewed only; no remote operation.
- `apps/clankie/test/fleet-host-fence.test.ts`: Keep actual HTTP MCP/WorkerMcp/host credential and final-admission awaits revocation fence; changed/disabled authority cannot reach provider.
- `apps/clankie/test/fleet-project-membership-routes.test.ts`: Keep independently authorized bounded no-store API, injected native proof/project refusal and post-await reauthorization, honest schema errors/private detail redaction.
- `apps/tui/test/accounts-command.test.ts`: Keep secret-stdin authenticated account route/redaction, persisted OAuth settings and provider device-code poll interval/request contract. Mixed prompt copy is a later candidate.
- `apps/tui/test/installer.test.ts`: Keep real installer/tar/checksum immutable version rollback with preserved owner state, one login PATH entry and linked harness refresh contract.
- `apps/tui/test/project-role-cli.test.ts`: Keep operator revision API whole-role/null/default preservation and model validation no-write; alternate native profile registration does not modify login.
- `apps/clankie/test/codex-hook-trust.test.ts`: Keep native discovered-hash trust limited to own installed worker hooks, owner-home and missing/guessed hash fail-closed, unrelated hooks/config untouched.
- `apps/clankie/test/minecraft-capture.test.ts`: Keep renderer loopback/session/generation/stale/dimension/body bounds and post-await ended-session fence, broker reconnect sink recovery.
- `apps/clankie/test/minecraft-host-tools.test.ts`: Keep host-proven identity versus forged tool args, typed admin injection/op refusal, diagnostics secret scrubbing and raw/delegated MCP hosting access denied.
- `apps/clankie/test/channel-turns.test.ts`: Keep actual observed Discord PASS leak regression, silent versus spoken sentinel semantics, lossless bounded native transcript and truthful unavailable versus quiet outcomes. Mixed exact prose/tie ordering remains later incidental candidate; stale PTY explanation warrants provenance review.
- `apps/clankie/test/hosted-security-wire.test.ts`: Keep real signed nonce/body digest/tenant/installation/lifetime schema state, persisted-before-register key rotation and device revoke versus account identity.
- `apps/clankie/test/lead-native-claude-launch.test.ts`: Keep evaluation harness native containment/lifetime safety fixture cases. Evaluation-related inputs are outside pruning and were not executed.
- `apps/clankie/test/captain-lane-prompt-assembly.test.ts`: Keep lane authority/private address/fleet preference exposure and VUH-1391/VUH-1456 documented instruction contracts, native harness project file compatibility. Keep exact default section order and blank-line separation: `docs/cli.md` publishes that launcher contract. The proposed spacing cut was withdrawn before changing the test.

## Model config and persona image presentation batch (proposed PR)

Reviewed the complete model-provider and persona-images test files and their real
consumers. Remove two config indentation/trailing-newline assertions, one trivial
`variantById` lookup case already exercised through the configured-model consumer,
and two image-count prose assertions. Keep the helper and all product exports;
parsed concurrent config values, atomic writes with no temporary leftovers, secret
rejection, model/effort schema and provider contracts remain. The unchanged
configured-model consumer proves matched effort variants and unsupported variant
refusal across the SDK request boundary with fixed local fetch replies. No live
provider request or eval runs. Both persona integration cases retain actual image
counts, file loading, settings persistence, missing-folder refusal and restart
warnings. No E2E, integration or golden file is removed.

The two touched files shrink from 935 to 923 lines, with one case removed:
12 lines and one case. Landed subtotal remains six batches, 688 lines and 39 cases.
If this PR merges, the subtotal becomes seven batches, 700 lines and 40 cases.
The already-landed Discord cut `70727e33` stays on main; its archive README and
manifest accompany this PR and are not counted again.
[Measurements and evidence](../testing/2026-10-09-model-config-test-pruning/README.md).
The remaining inventory is incomplete.

Further complete public-file reviews retain:

- `apps/clankie/test/discord-room-voice.test.ts`: Keep exact one-use host nonce, owner/source post-await revocation, foreign/replayed command refusal, retained durable audio ownership on empty/foreign/restarted body snapshots.
- `apps/clankie/test/minecraft-port.test.ts`: Keep published controllable port fixture contract: idempotent IDs, cancellation versus world-effect evidence, unsettled motor fences, generation-specific disconnect/callback authority and unknown completion. Fake-only proof, no live server.
- `apps/clankie/test/minecraft-routes.test.ts`: Keep actual HTTP routes/settings/body lease integration, operator authority, input/secret bounds, revocation before persistence, captured conversation ownership and exact-disconnect release; fake port remains explicit.
- `apps/clankie/test/presence.test.ts`: Keep opt-in public projection/schema, owner-item precedence, stable cursors, strict bounded long polls and cancellation, unresolved lane handling and actual protocol client request seam.
- `apps/clankie/test/project-worktree-routes.test.ts`: Keep owner API enrollment of native-observed Git identity, no caller facts/no observation for unauthorized requests, authority/settings/native-root races at persistence and selected-root removal.
- `apps/clankie/test/worker-skills.test.ts`: Keep real filesystem and native loader integration: isolated Codex config, shared hook-file trust identity/no duplicate tables, owner config preservation, session/auth/tool links and every shipped skill through three harness loaders.

- `apps/tui/test/inbound-receipt.test.ts`: Keep durable native delivery receipt isolation: old responder cannot settle newer claim, corrupt/locked state fails closed, exact pre-dispatch refusal versus uncertain outcome and authorization refusal without POST.
- `apps/tui/test/project-create-cli.test.ts`: Keep published CLI/TUI reviewed settings/revision command contract, broker credential and authority-field injection fences, canonical API transport/quoted paths, no retry after refused writes and honest unavailable tracker.
- `apps/clankie/test/discord-ingress.test.ts`: Keep real Ed25519/ECDH encrypted ingress, durable admission and restart deduplication, uncertain machine turn non-replay, content redaction and unsealed/forged/wrong-tenant/oversize refusal.
