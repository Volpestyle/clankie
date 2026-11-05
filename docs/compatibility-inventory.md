# Migration and compatibility inventory

This is the retirement ledger for [#337](https://github.com/Volpestyle/clankie/issues/337).
The current [real-file proof map](migration-file-coverage.md) records the settings,
project and conversation source-shape release evidence and kept-reader checks.

The [original source inventory](https://github.com/Volpestyle/clankie/issues/337#issuecomment-6629246987)
covered 61 paths at `512eeb9a7`. The catalogue below preserves that baseline's
markers and release notes; it is not evidence that any install has completed
those migrations. Approximate line locations and counts belong to that source
revision, not the current tree. A first release is the first containing the
observed introduction, which can be a moved string or comment, not a supported
upgrade floor. The four previously undetermined entries have the source/tag evidence below;
none of these provenance notes establishes a supported upgrade floor.

## Retirement decisions

Rechecked the project setter at `fdbf15770`: P4 is an internal forwarding
alias, not a disk reader or wire decoder. Its sole production caller already
imports `setProjectRole`; it can name `DEFAULT_PROJECT_ID` there directly.
Tests use the same canonical setter. Removing this alias changes no persisted
shape, migration receipt, default-project creation, role validation or membership
admission. `@clankie/settings` is a private workspace package; source callsites,
not an installed data marker, are the retirement evidence for this row.

All other rows remain. In particular, absence of a marker on one Mac would not
establish absence across installations, retained history, restored backups or
older app builds. No other machine or device has been inspected for this audit.
There is no proven oldest-supported runtime/app cohort or complete marker scan
attached to #337 yet. Do not remove disk/wire paths based on this ledger alone.

The real `migratePersonaRoles` flow (P1) stays: settings commit and readback must
precede identity cleanup; its receipt prevents a restarted migration from
resurrecting an owner-edited assignment. P2/P3 identity readers stay too.
The project/role integration tests keep exercising those old records after
the alias is removed.

## Baseline catalogue

Kind D = on-disk migration; W = wire compatibility; O = other compatibility.
Short paths below are rooted in `packages/settings/src`,
`packages/protocol/src`, or `apps/clankie/src` as named. “conversations”
means `apps/clankie/src/captain/conversations`; herdr-watch/personas are
under `apps/clankie/src/captain`. Use each marker/function to locate moved code.

| ID  | Where                                                                   | ~Lines | Kind | Migrates from                                                                                                                                   | Marker                                             | First release          |
| --- | ----------------------------------------------------------------------- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------- |
| S1  | settings schema.ts:1038-1114                                            | 77     | D    | retired top-level and nested keys (linear, swarm, skills, execution._, gameplay._, email.provider, fleet.remoteGates, linearWebhook.actorEmail) | any key in raw settings.json                       | v0.2.0                 |
| S2  | settings store.ts:237-267                                               | 31     | D    | linearWebhook.wake without ownerUserEmails                                                                                                      | wake present, no ownerUserEmails                   | v0.4.0                 |
| S3  | settings schema.ts:963-964,1000-1036                                    | 39     | D    | project clankie without autonomy.fleet.release                                                                                                  | no working-preference leaf, project lacks release  | v0.4.0                 |
| S4  | settings schema.ts:902-907,966-998; project-work-policy.ts:33-50        | 57     | D    | fleet.size/models, fleet.hire.effort, verification, reportingStyle                                                                              | retiredWorkingPreferences absent                   | v0.4.5                 |
| S5  | discord-settings.ts:500-551                                             | 52     | D    | discord without servers; systemActor IDs                                                                                                        | discord.servers absent                             | v0.4.0                 |
| S6  | discord-settings.ts:331-378, 381-476                                    | 73     | D    | flat serverId/role/fleetEnabled/trackingLevel, no guilds                                                                                        | guilds empty and serverId set                      | v0.4.7                 |
| S7  | discord-settings.ts:314-329                                             | 16     | D    | possessorVoiceEnabled, officialBotEnabled                                                                                                       | those keys                                         | after v0.4.11          |
| S8  | settings store.ts:269-318,333-345                                       | 60     | D    | agentHosts.connections; execution.connections[].ssh                                                                                             | either key                                         | v0.4.0                 |
| S9  | settings store.ts:319-332                                               | 14     | D    | linked machine with no machineAccess entry                                                                                                      | enabled connection, no entry                       | v0.4.0                 |
| S10 | discord-resolve.ts:147-149,220-224                                      | 7      | O    | env DISCORD_SWARM_GUILD_ID                                                                                                                      | env var on the service                             | v0.4.0                 |
| S11 | settings schema.ts:147-158                                              | 12     | D    | gateway hostId, not installationId                                                                                                              | hostId, no installationId                          | v0.2.0                 |
| S12 | fleet-resources.ts:12-17                                                | 5      | D    | retired pressure floors                                                                                                                         | keys in settings or journals                       | after v0.4.11          |
| P1  | personas.ts:249-296; settings projects.ts:130-164; protocol projects.ts | 93     | D    | personas[].role                                                                                                                                 | role in personas.json; legacyRoleMigration receipt | v0.4.0                 |
| P2  | personas.ts:61-66,76,798-801                                            | 11     | D    | personas schemaVersion 1, occupant-derived IDs                                                                                                  | schemaVersion 1; agent-<64 hex> IDs                | v0.2.0                 |
| P3  | personas.ts:49-53                                                       | 5      | D    | personas[].swarm                                                                                                                                | swarm key                                          | v0.4.0                 |
| P4  | settings projects.ts:166-173                                            | 8      | O    | setDefaultProjectRole (retired alias; use setProjectRole)                                                                                       | code callers only                                  | v0.4.0                 |
| P5  | project-hires.ts:56-57,368-370                                          | 5      | D    | allocation without beganAt                                                                                                                      | row without it                                     | after v0.4.11          |
| P6  | project-hires.ts:861-862                                                | 2      | D    | old policy string                                                                                                                               | live allocation with old value                     | v0.4.0                 |
| P7  | project-routes.ts:37-92, 142-382                                        | 60     | W    | strict client without project policy fields                                                                                                     | GET without include flags                          | v0.4.0                 |
| P8  | project-routes.ts:231-244                                               | 13     | W    | client sending trackerProjectId                                                                                                                 | update carrying it                                 | v0.4.0                 |
| P9  | work-tracker-settings.ts:168-174                                        | 3      | O    | repo convention backend default                                                                                                                 | that convention in a workspace                     | v0.4.7                 |
| P10 | work-items.ts:2083-2100                                                 | 18     | O    | legacy route for one saved Linear scope                                                                                                         | single saved binding                               | v0.4.5                 |
| P11 | tracker-owner-loop.ts:277-290                                           | 12     | D    | loop ref without host-bound ask link                                                                                                            | entry in tracker/owner-loop.json                   | v0.4.0                 |
| C1  | conversations store.ts:386-392,4121-4127; types.ts; transcripts.ts      | 19     | D    | inline seatTranscript.entryIds, messageIds                                                                                                      | seatTranscript without index                       | after v0.4.11          |
| C2  | transcripts.ts:47-65,265-323                                            | 78     | D    | last-answer projection                                                                                                                          | ambiguous                                          | v0.2.0                 |
| C3  | tracker-wakes.ts:313-347; store.ts:565,798-800                          | 39     | D    | conversations/linear-inbox, linear-work.json                                                                                                    | either path                                        | v0.4.0                 |
| C4  | conversations store.ts:617-630                                          | 14     | D    | linear* cursors in meta.json                                                                                                                    | any key                                            | v0.4.0                 |
| C5  | linear-notifications.ts:4-8; index.ts:1844                              | 6      | D    | linear-notifications.json                                                                                                                       | file exists                                        | v0.4.0                 |
| C6  | inbound-report-migration.ts; store.ts:605-612,4131-4156; index.ts:1491  | 118    | D    | inline inboundAcceptances                                                                                                                       | key present, no inboundReportStore                 | after v0.4.11          |
| C7  | native-seats.ts; store.ts; operator-conversations.ts:391-392,2529       | 65     | D    | scope seat; channelMembers[].seatId                                                                                                             | either in meta.json                                | v0.2.0                 |
| C8  | operator-conversations.ts:2057,2077; channel-projection.ts:408,421      | 6      | D    | event seatId, linear.notification                                                                                                               | in retained events                                 | v0.2.0                 |
| C9  | conversations store.ts:680-692; questions.ts:189-197                    | 21     | D    | pending decision without decisionPolicy                                                                                                         | such a record                                      | v0.4.5                 |
| C10 | conversations store.ts:2783-2795; questions.ts:858-864                  | 20     | D    | pending projectCreation or purpose preference                                                                                                   | such a record                                      | v0.4.0                 |
| H1  | herdr-watch.ts:204-205                                                  | 2      | D    | watch without occupantId                                                                                                                        | row without it                                     | v0.4.0                 |
| H2  | herdr-watch.ts:2743-2745,2775-2777,2780-2786                            | 13     | D    | allocation keyed by bare pane                                                                                                                   | unqualified pane                                   | v0.4.0                 |
| H3  | herdr-watch.ts:4887-4888,4943-4947                                      | 7      | D    | receipt without sessionId                                                                                                                       | unsettled receipt lacking it                       | v0.4.0                 |
| H4  | herdr-watch.ts:4602-4603,4817                                           | 10     | D    | older allocation, no matching receipt                                                                                                           | unconfirmed remote allocation                      | after v0.4.11          |
| H5  | herdr-watch.ts:5559-5590                                                | 35     | O    | legacy adapters without account discovery                                                                                                       | none                                               | v0.4.5                 |
| H6  | herdr-watch.ts:2832,7817-7820; fleet-seat-control.ts:667-670            | 10     | D    | fleet.hire.effort; fences without nativeDeliveryId                                                                                              | key; fence entries                                 | v0.4.5                 |
| W1  | work-items.ts:391-395; conversation-routes.ts:1506                      | 7      | W    | client without backlog or milestone                                                                                                             | work_items without statusVersion 2                 | v0.4.0                 |
| W2  | body-leases.ts:125-130; runtime.ts:1964-1972                            | 12     | W    | closed resource enum without computer                                                                                                           | none                                               | after v0.4.11          |
| W3  | discord-room-routes.ts; discord-settings.ts:296-312,389-395             | 44     | W    | client omitting or sending retired settings                                                                                                     | such a save                                        | v0.4.9                 |
| W4  | model-key-routes.ts:224-228                                             | 5      | W    | clankie/routine, clankie/escalation                                                                                                             | those values                                       | v0.4.0                 |
| W5  | conversations store.ts:1149-1153; conversation-routes.ts:1287-1293      | 10     | W    | stop_task result without reason                                                                                                                 | no includeReason                                   | after v0.4.11          |
| W6  | operator-service.ts:1150-1158                                           | 10     | W    | new device, older service or relay                                                                                                              | 503 without seatHandoff                            | v0.4.10                |
| W7  | operator-service.ts:503-504,1363-1364                                   | 4      | W    | strict send_receipt client                                                                                                                      | no record:true                                     | v0.4.10                |
| W8  | runtime.ts:2488-2534; fleet-settings-routes.ts                          | 55     | W    | strict client without work-policy fields                                                                                                        | no includeWorkPolicy                               | v0.4.5                 |
| W9  | presence.ts:136-144; captain/presence.ts                                | 12     | W    | strict presence reader                                                                                                                          | no include flags                                   | v0.4.0                 |
| W10 | operator-service.ts:779-782,821-824                                     | 10     | W    | strict fleet, terminal_catalog                                                                                                                  | no includeWork, includeSeatIds                     | v0.4.0 / after v0.4.11 |
| W11 | operator-conversations.ts:2183-2191                                     | 9      | W    | unsupported event variant                                                                                                                       | standing contract                                  | v0.2.0                 |
| W12 | operator-conversations.ts:1351-1362                                     | 12     | W    | spawn results with skills                                                                                                                       | older host                                         | v0.4.0                 |
| W13 | integrate.ts:1-40                                                       | 40     | O    | /v1/integrate/shipping schema                                                                                                                   | clankie-app import                                 | v0.4.7                 |
| W14 | public-gateway.ts:216-217                                               | 2      | W    | hosted pair-offer route                                                                                                                         | POST to it                                         | v0.3.0                 |
| W15 | conversation-tail-hub.ts:184-186                                        | 3      | O    | peer ignoring waitMs                                                                                                                            | instant empty tails                                | v0.4.0                 |
| W16 | projects.ts:645-670                                                     | 25     | W    | host without membership route                                                                                                                   | route unavailable                                  | v0.4.0                 |
| W17 | fleet-messages.ts:88-89; seat-outbox.ts; seat-routes.ts:437-450         | 28     | O    | seat bridge without capability handshake                                                                                                        | poll without header                                | v0.4.0                 |
| W18 | conversation-routes.ts:210-211                                          | 2      | W    | device-level activity only                                                                                                                      | no channel activity                                | after v0.4.11          |
| W19 | fleet-messages.ts:268-269                                               | 2      | W    | seat message without delivery                                                                                                                   | decode without it                                  | v0.4.0                 |
| W20 | devices.ts:60-64; protocol devices.ts:410-420                           | 17     | D    | device.pairing.restarted events                                                                                                                 | type in events.jsonl                               | v0.4.5                 |
| W21 | captain-lanes.ts:24-41                                                  | 18     | O    | lane tui                                                                                                                                        | sourceLane tui in records                          | v0.2.0                 |
| W22 | conversations store.ts:3394-3400                                        | 3      | W    | older callers with automatic steering                                                                                                           | turn without delivery                              | v0.2.0                 |

## Previously undetermined release notes

The first containing release was checked with `git tag --contains COMMIT --sort=version:refname`:

- P8: [674502032](https://github.com/Volpestyle/clankie/commit/674502032) introduced the tracker UUID update and strict-client omission, first contained in v0.4.0.
- P10: [16bde179f](https://github.com/Volpestyle/clankie/commit/16bde179f) introduced the single saved tracker-scope fallback, first contained in v0.4.5.
- W10 combines two opt-ins: `includeWork` appears in [9bacc419b](https://github.com/Volpestyle/clankie/commit/9bacc419b), first contained in v0.4.0; `includeSeatIds` appears in [5d75eb87a](https://github.com/Volpestyle/clankie/commit/5d75eb87a), with no containing release tag through v0.4.11. Both still have source consumers. The current service implementation is `captain/captain-operator-service.ts`.
- W19: [a9c5d520d](https://github.com/Volpestyle/clankie/commit/a9c5d520d) made seat-message delivery optional on decode while requiring it for writes, first contained in v0.4.0. [869d2a738](https://github.com/Volpestyle/clankie/commit/869d2a738) moved it into `fleet-messages.ts`; the move is not its introduction.

## Evidence needed for further removal

For each supported runtime/install cohort, record its version/source SHA and
which raw-file markers above were checked, with counts only. Keep raw settings,
identities, conversation metadata and credentials local. A missing file, an
offline host, an unreadable store or an unscanned backup is **unknown**, never
a zero. Do not invoke a store's migration-on-read code just to audit its raw shape.
The owner/lead must supply evidence for machines outside the worker's authority.

For wire rows, name the app builds and other clients still supported and
exercise their old request shapes against the proposed host. Keep ADR 0221's
old-client/new-host cases: project include flags (P7), retired Discord fields
(W3), optional stop reasons (W5), receipt opt-ins (W7), fleet include flags (W8),
presence opt-ins (W9), fleet/terminal projections (W10), and other W rows are not
made obsolete by clean server files. Older-server fallbacks (W6/W12/W16/W19)
likewise need a supported host-version floor, not a local marker scan.

Remove one area per commit only after its evidence is attached. Preserve the
strict-schema drop lists (S1/S7) and the retained policy fields (S12): deleting
these readers can make an otherwise readable old file fail validation. Retain migrations introduced after v0.4.11:
that release's files can be the very inputs they upgrade. Hosted-client mode
and managed-model cleanup remain separately tracked in #150.

## Current managed-server and worker names (#336)

Current settings use `discord.managedGuildId`; an existing settings file with
`discord.swarmGuildId` loads the same value through the normal settings-store
migration. A later ordinary save writes the canonical key. If both file keys
are present, the explicit canonical key wins; invalid canonical input is still
refused rather than falling back to the old value.

`DISCORD_MANAGED_GUILD_ID` is preferred, and `DISCORD_SWARM_GUILD_ID` remains an
input alias. Explicit environment values retain their existing precedence over
stored settings, with the canonical environment name preferred when both are
set. The CLI uses `clankie discord set --managed-guild-id ID` and also accepts
`--swarm-guild-id` for existing commands. Both name the same selected server.

The worker entry point is `bin/worker-mcp.mjs`; `bin/swarm-mcp.mjs` forwards to
it for existing registrations. New joined Codex hires also launch the canonical
`worker-mcp.mjs` path; already registered legacy paths keep working.
Retired enrollment/refusal keys, environment
scrubbers, historical channel receipts and frozen eval fixtures keep their
original strings so compatibility checks and recorded evidence remain valid.
The baseline retirement catalogue above is unchanged by this naming migration.
