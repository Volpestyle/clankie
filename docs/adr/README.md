# Architecture decision records

ADRs preserve why a decision was ratified. `accepted` means ratified, not
necessarily implemented or still current. Superseded records remain in place;
later ADRs link back to the decision they amend or replace. Read the
[current architecture](../architecture.md) for the implemented system; the archive
below identifies decisions whose former implementation or scope is historical.

## Conventions

- Put current setup, commands, configuration, and implementation state in the
  owning app or package README. ADRs keep the decision, evidence, alternatives,
  and consequences.
- Link amendments and superseding decisions in the status paragraph. Historical
  implementation details stay explicitly historical rather than claiming to
  describe the running system.
- When a decision retires guidance that agents or users read, add the retired
  phrasing to [retired-claims.json](retired-claims.json). `pnpm docs:check` then
  fails wherever live code, skills or guides still repeat it.
- Link ADRs by stable filename, not by number alone. Accepted ADRs are never
  renumbered, except once to end the four historical collisions below.
- Allocate the next unused number after checking fetched main. `pnpm docs:check` and
  `pnpm check:landing` reject duplicate numbers.

### Renumbered records

Until 2026-10-17 numbers 0098, 0189, 0191 and 0207 each named two records.
[VUH-2396](https://linear.app/vuhlp/issue/VUH-2396) moved one of each pair to a
new number: a proposed record gave way to an accepted one, otherwise the later
one moved, and the less-cited one when both landed in the same commit. Links and
citations written before then may use the former number; this table resolves them.

| Former number and file                                           | Now                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0098 `0098-the-room-can-type-to-a-playthrough.md`                | [ADR 0275: The room can type to a playthrough](0275-the-room-can-type-to-a-playthrough.md)                               |
| 0189 `0189-agent-sessions-read-from-their-transcripts.md`        | [ADR 0276: Agent sessions read from their transcripts](0276-agent-sessions-read-from-their-transcripts.md)               |
| 0191 `0191-a-reply-to-his-post-goes-to-whoever-owns-the-work.md` | [ADR 0277: A reply to his post goes to whoever owns the work](0277-a-reply-to-his-post-goes-to-whoever-owns-the-work.md) |
| 0207 `0207-workers-publish-through-one-clankie-app.md`           | [ADR 0278: Workers publish through one Clankie app](0278-workers-publish-through-one-clankie-app.md)                     |

The other record of each pair keeps its number:
[ADR 0098](0098-user-session-watches-discord-shares.md) (user-session shares),
[ADR 0189](0189-his-own-linear-activity-does-not-wake-him.md) (Linear echoes),
[ADR 0191](0191-work-is-tracked-where-the-repo-tracks-it.md) (work tracking) and
[ADR 0207](0207-work-records-and-native-agent-delivery.md) (native delivery).

## Diagrams

[ADR 0210](0210-objectives-outlive-agent-turns.md) records the separation of
native goals, explicit session assignments and current activity.

Diagrams are Mermaid in the Markdown that owns the subject, so they render on
GitHub and in Linear and change in the same commit as the code. The
[architecture](../architecture.md) keeps the system map, the message-to-turn
flow and the fleet flow; subsystem diagrams live in their package or app
README. The former tldraw sources and JPG exports were removed on 2026-10-06;
git history keeps them.

[ADR 0215](0215-conversations-lease-one-body.md) records exclusive body-resource
leases for parallel conversations belonging to one Clankie.

[ADR 0216](0216-projects-own-agent-roles-and-tool-policy.md) moves agent roles and
project policy into owner settings, with lossless persona migration and per-agent
membership rules.

[ADR 0217](0217-fleet-membership-gets-connected-tools.md) supersedes ADR 0216's
fleet tool gate: admitted fleet members reach verified connected accounts through
`clankie_tools` and `clankie_call`, with an owner kill switch.

[ADR 0218](0218-native-seats-drive-their-attached-conversation.md) lets native
harness seats drive a selected conversation, preserving room grants and delivery
receipts across handover, and routes worker reports to their persisted lead.

[ADR 0220](0220-clankie-has-one-present-tense.md) adds one `presence` operator
operation, a `desktop` tool for his own expressions, and hero pixel art in
`branding/pet/`; the desktop pet itself lives in the private app.

[ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md) prioritizes real
E2E, integration and golden coverage for new work; existing unit-test pruning
remains a separate reviewed effort.

- [0222 — Discord setup has one shared definition](0222-discord-setup-has-one-shared-definition.md)
- [0225 — Minecraft keeps playing with one driver](0225-minecraft-keeps-playing-with-one-driver.md)

- [0226 — One tracker tool surface](0226-one-tracker-tool-surface.md)

[ADR 0214's VUH-1678 amendment](0214-linear-wakes-require-attribution-and-rules.md#amendment--one-ordinary-chat-receives-signed-linear-activity-2026-10-04)
supersedes ADR 0218's Linear routing extension: verified rule-passing webhooks
wake one ordinary configured chat, `global-default` by default, and retire the
separate Linear inbox protocol. Clankie can set the non-secret target and rules.

- [0227 — Discord connects a server with a role](0227-discord-connects-a-server-with-a-role.md)
- [0228 — Quick actions are skills, and tidy keeps results](0228-quick-actions-are-skills-and-tidy-keeps-results.md)
- [0232 — Hosted Connections use the body broker](0232-hosted-connections-use-the-body-broker.md)

- [0229 — Room handoffs are visible parallel threads](0229-room-handoffs-are-visible-parallel-threads.md)
- [0230 — Fleet responsibility is owner settings](0230-fleet-responsibility-is-owner-settings.md)
- [0233 — Activity shares own their media scope](0233-activity-shares-own-their-media-scope.md)
- [0234 — Games share one extension contract](0234-games-share-one-extension-contract.md)

- [0235 — Worker catalog refresh keeps the original controller](0235-worker-catalog-refresh-keeps-the-original-controller.md)
- [0236 — Clankie owns the skills he ships](0236-clankie-owns-the-skills-he-ships.md)
- [0237 — Hosted bodies update themselves to official releases](0237-hosted-bodies-update-themselves-to-official-releases.md)
- [0238 — Hosted Claude workers trust their own workspace](0238-hosted-claude-workers-trust-their-own-workspace.md)
- [0239 — Worker harnesses sign in with their own logins](0239-worker-harnesses-sign-in-with-their-own-logins.md)
- [0240 — Changes land directly on main](0240-changes-land-directly-on-main.md)
- [0241 — One official Discord bot serves every Clankie](0241-one-official-discord-bot-serves-every-clankie.md)
- [0242 — Every Clankie has a mailbox we run](0242-every-clankie-has-a-mailbox-we-run.md)
- [0243 — Linear GraphQL is the tracker escape hatch](0243-linear-graphql-is-the-tracker-escape-hatch.md)
- [0244 — Machines join Clankie at an access level](0244-machines-join-clankie-at-an-access-level.md)
- [0247 — Narrow checks have one command](0247-narrow-checks-have-one-command.md)
- [0249 — Simulator leases answer promptly and name their holders](0249-simulator-leases-answer-promptly-and-name-their-holders.md)

- [0251 — Discord servers have owners; rooms can grant skills](0251-discord-owners-and-room-skills.md)
- [0252 — Household legacy authors need owner-confirmed ID bindings](0252-household-legacy-authors-need-owner-confirmed-id-bindings.md)
- [0253 — Owner confirmation needs an isolated authority (proposed)](0253-owner-confirmation-needs-an-isolated-authority.md)
- [0255 — A lent screen keeps consent and stops on its host](0255-a-lent-screen-keeps-consent-and-stops-on-its-host.md)
- [0256 — Lent input needs native drain proof](0256-lent-input-needs-native-drain-proof.md)
- [0257 — A lowered local runtime keeps an OS boundary](0257-a-lowered-local-runtime-keeps-an-os-boundary.md)
- [0258 — Evidence lives in the evidence store](0258-evidence-lives-in-the-evidence-store.md)
- [0260 — Usage meters come from each harness's own CLI](0260-usage-meters-come-from-each-harness.md)
- [0261 — Hires go where capacity would otherwise go unused](0261-hires-go-where-capacity-would-go-unused.md)
- [0262 — Prime Agent's operator seat is a resident daemon session](0262-prime-agent-operator-seat-is-a-resident-daemon-session.md)
- [0263 — One autonomy dial over the decision leaves](0263-one-autonomy-dial-over-the-decision-leaves.md)
- [0264 — Projects on Auto replace goals](0264-projects-on-auto-replace-goals.md)
- [0265 — Routines are recurring jobs with a run fence](0265-routines-are-recurring-jobs-with-a-run-fence.md)
- [0266 — Landing gates keep isolation and load less](0266-landing-gates-keep-isolation-and-load-less.md)

## Archived decisions

**Archived** means superseded or retired for the scope named below. These records
retain their stable paths and historical rationale; archiving does not delete
an ADR or change the surviving constraints explicitly noted in its status.
The links in this table follow each record's current-status paragraph and the
superseding decisions.

| Status   | Record                                                                                                                                   | Archived scope / current decision                                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archived | [ADR 0025: ClankVox is an in-repo voice sidecar behind versioned bridge IPC](0025-clankvox-placement-and-ipc.md)                         | Sole-owner media and native package placement. [ADR 0128: Vox is the sole Discord media owner](0128-vox-is-the-sole-discord-media-owner.md); [ADR 0100: Vox is an owned native media package](0100-vox-is-an-owned-native-media-package.md). |
| Archived | [ADR 0039: GBA emulator embodiment and the deterministic core boundary](0039-gba-emulator-embodiment-and-deterministic-core-boundary.md) | Local GBA body retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                                          |
| Archived | [ADR 0040: Real headless mGBA core behind the emulator seam](0040-real-mgba-core-behind-the-emulator-seam.md)                            | Local mGBA core retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                                         |
| Archived | [ADR 0044: The runner owns Mineflayer while Paper owns Minecraft success](0044-runner-owned-mineflayer-private-paper-gameplay.md)        | Runner-owned Minecraft body removed; current offline Minecraft uses an MCP motor. [ADR 0219: Minecraft is an MCP-connected body](0219-minecraft-is-an-mcp-connected-body.md).                                                                |
| Archived | [ADR 0053: An external harness possesses Clankie under a lease](0053-mcp-possession-of-clankies-body.md)                                 | Possession replaced by independent player identity. [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md); [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                        |
| Archived | [ADR 0064: The possessor voice seam](0064-possessor-voice-seam.md)                                                                       | Possessor voice scope retired; neutral Clankie play voice survives. [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md).                                                                                                    |
| Archived | [0075. Rewinding is a play choice](0075-rewinding-is-a-play-choice.md)                                                                   | Local rewind retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                                            |
| Archived | [ADR 0090: Emerald plays from the screen](0090-emerald-plays-from-the-screen.md)                                                         | Local screen-only Emerald implementation retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                |
| Archived | [ADR 0125: The menu bar is a private local voice room](0125-the-menu-bar-is-a-private-local-voice-room.md)                               | Menu-bar voice room retired. [0203 — Clankie keeps what better models cannot absorb](0203-clankie-keeps-what-better-models-cannot-absorb.md).                                                                                                |
| Archived | [ADR 0130: Goals and self-wakes share the operator thread](0130-goals-and-self-wakes-share-the-operator-thread.md)                       | Service goals retired; self-wakes and the global switch survive. [ADR 0264: Projects on Auto replace goals](0264-projects-on-auto-replace-goals.md).                                                                                         |
| Archived | [ADR 0132: A goal keeps a decision journal](0132-a-goal-keeps-a-decision-journal.md)                                                     | Retired with service goals. [ADR 0264: Projects on Auto replace goals](0264-projects-on-auto-replace-goals.md).                                                                                                                              |
| Archived | [0180. Swarm owns cross-session coordination](0180-swarm-is-the-coordination-layer.md)                                                   | Swarm coordination retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                                |
| Archived | [0182. Swarm peers are messageable personas](0182-swarm-peers-are-messageable-personas.md)                                               | Swarm peer personas retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                               |
| Archived | [ADR 0194: Interactive Swarm workers receive leased channel events](0194-interactive-swarm-workers-receive-leased-channel-events.md)     | Swarm channel delivery retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                            |
| Archived | [ADR 0198: One coordinator reaches every fleet](0198-one-coordinator-reaches-every-fleet.md)                                             | Swarm coordinator retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                                 |
| Archived | [ADR 0205: The fleet carries its open Swarm tasks](0205-the-fleet-carries-its-open-swarm-tasks.md)                                       | Swarm task projection retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                             |
| Archived | [ADR 0242: Every Clankie has a mailbox we run](0242-every-clankie-has-a-mailbox-we-run.md)                                               | Hosted mailbox retired; mail is the owner's IMAP/SMTP server. [ADR 0326: The last hosted leftovers are removed](0326-the-last-hosted-leftovers-are-removed.md)                                                                               |

### Archived scopes within continuing records

These ADRs retain a live boundary or an unimplemented proposal. Only the named
scope is archived; readers should follow the successor for its implementation.

| Record                                                                                                                  | Archived scope                                                           | Continuing boundary / successor                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR 0045: Official-bot group voice uses the maintained Discord media stack](0045-official-bot-dave-group-voice.md)     | Archived: Node voice/Opus media owner and split-stack rollout.           | Consent, attribution, floor, and positive DAVE evidence remain; media ownership follows [ADR 0128: Vox is the sole Discord media owner](0128-vox-is-the-sole-discord-media-owner.md).    |
| [ADR 0059: Lease expiry pauses the body; only revocation is final](0059-lease-expiry-pauses-the-body.md)                | Archived: Possession and cross-process body lock.                        | Internal action/lease recovery is retained in its applicable scope; independent body ownership follows [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md).             |
| [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md)                                                    | Archived: Local emulator body.                                           | Independent player identity remains; the Pokémon body follows [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                |
| [ADR 0170: A session that stops is unbound](0170-a-session-that-stops-is-unbound.md)                                    | Archived: Ambient selection and automatic replacement of a lost session. | Explicit binding and its current CLI contract follow [0181. Clankie is independent of his connections](0181-clankie-is-independent-of-his-connections.md).                               |
| [ADR 0276: Agent sessions read from their transcripts, on any host](0276-agent-sessions-read-from-their-transcripts.md) | Archived: Headless resumed turns and Swarm identity proposals.           | Transcript reading remains; native interactive work follows [0203 — Clankie keeps what better models cannot absorb](0203-clankie-keeps-what-better-models-cannot-absorb.md).             |
| [ADR 0208: Agents carry a role; the world reads it](0208-agents-carry-a-role-the-world-reads-it.md)                     | Archived: Identity-role storage.                                         | Roles move into project policy under [ADR 0216: Projects own agent roles and tool policy](0216-projects-own-agent-roles-and-tool-policy.md).                                             |
| [ADR 0216: Projects own agent roles and tool policy](0216-projects-own-agent-roles-and-tool-policy.md)                  | Archived: Fleet tool gate tied to project membership.                    | Project roles, caps, hiring, and tracker binding remain; connected tool access follows [ADR 0217: Fleet membership gets connected tools](0217-fleet-membership-gets-connected-tools.md). |

- [0246 — Worker questions use native hook answers](0246-worker-questions-use-native-hook-answers.md)
- [0248 — Owner settings use one revision-fenced API](0248-owner-settings-use-one-revision-fenced-api.md)

- [0267 — Skins share one public animation spec](0267-skins-share-one-public-animation-spec.md)
- [0268: Account-owned device revocation survives a sleeping body](0268-account-owned-device-revocation-survives-a-sleeping-body.md) — VUH-2121 / VUH-2215.

- [0269: Browser pairing binds an account session to one device](0269-browser-pairing-binds-an-account-session-to-one-device.md) — VUH-2122.

- [0270: Auto rounds measure outcomes and name drift](0270-auto-rounds-measure-outcomes-and-name-drift.md) — VUH-2255.
- [0271: The lead seat restarts fresh in its own pane](0271-the-lead-seat-restarts-fresh-in-its-own-pane.md) — VUH-2274.
- [0272: A hosted body runs model-directed work as a separate uid](0272-a-hosted-body-runs-model-directed-work-as-a-separate-uid.md) — VUH-2320 (Proposed).
- [0273: The fleet room is a durable, owner-only coordination record](0273-the-fleet-room-is-a-durable-owner-only-coordination-record.md) — VUH-2184.

- [0279: Fleet counts come from the host roster](0279-fleet-counts-come-from-the-host-roster.md) — VUH-2448.
- [0280: Automatic tidy requires positive work proof](0280-automatic-tidy-requires-positive-work-proof.md) — VUH-2462; amended for home and repository containers (VUH-2926) and moved, not copied, evidence (VUH-2932).

- [0281 — Paired devices read a shipping projection](0281-paired-devices-read-a-shipping-projection.md)
- [0282: Settings can save trust with autonomy](0282-settings-can-save-trust-with-autonomy.md) — VUH-2525.

- [0284: A service restart pauses one Pi room turn](0284-a-service-restart-pauses-one-pi-room-turn.md) — VUH-2574 (bounded prototype).
- [0285: Hosted presence has no idle clock](0285-hosted-presence-has-no-idle-clock.md) — VUH-2575.
- [0286: One body holds Clankie at a time](0286-one-body-holds-clankie-at-a-time.md) — VUH-2577.
- [0287: A standing reviewer gates every landing](0287-a-standing-reviewer-gates-every-landing.md) — VUH-2616. Amends ADR 0240.
- [0288: A device call is a voice body of the same session](0288-a-device-call-is-a-voice-body-of-the-same-session.md) — VUH-2682. Extends ADR 0057 and ADR 0215.
- [0289: A call through the gateway is a sealed stream](0289-a-call-through-the-gateway-is-a-sealed-stream.md) — VUH-2761. Amends ADR 0173; extends ADR 0288.

- [0290: App switch metrics are bounded device reports](0290-app-switch-metrics-are-bounded-device-reports.md) — VUH-2558.
- [0291: A room thinks in one loop](0291-a-room-thinks-in-one-loop.md) — VUH-2796 (Proposed). Would amend ADR 0229 for Pi text rooms.

- [0292: Onboarding opens an explicit local seat](0292-onboarding-opens-an-explicit-local-seat.md) — VUH-2784. Extends ADR 0152 and ADR 0248.
- [0293: A seat is sized by its work, not its window](0293-a-seat-is-sized-by-its-work-not-its-window.md) — VUH-2820 (Accepted). Extends ADR 0271.
- [0294: Owner activity glimpses follow live presence](0294-owner-activity-glimpses-follow-live-presence.md) — VUH-2819.
- [0295: A self-hosted bot admits its own Activity viewers](0295-a-self-hosted-bot-admits-its-own-activity-viewers.md) — VUH-2833. Extends ADR 0233.
- [0296: Hired workers run under an OS profile that keeps the owner's credentials](0296-hired-workers-run-under-an-os-profile.md) — VUH-2592.
- [0298: Linked repos are read-only sources, never owners](0298-linked-repos-are-read-only-sources.md) — LOCAL-VUH-41. Extends ADR 0270.
- [0299: The owner's app gives the verdict on finished work](0299-the-owners-app-gives-the-verdict-on-finished-work.md) — LOCAL-VUH-58. Extends ADR 0226 and ADR 0245.
- [0300: Clankie runs only on the owner's machine](0300-clankie-runs-only-on-the-owners-machine.md) — retires the hosted body of ADR 0183, 0237, 0241 and 0285.
- [0301: Claude reaches the fleet through a narrow connector](0301-claude-reaches-the-fleet-through-a-narrow-connector.md) — a remote MCP connector that lists, reads and messages agents, signed in by the owner.
- [0302: Posting to your tracker is the owner's call](0302-posting-to-your-tracker-is-the-owners-call.md) — per project: read only, ask me, Clankie decides or go ahead for Linear and GitHub writes. Extends ADR 0226 and ADR 0230.
- [0303: Connected apps answer the prompts open in agents' panes](0303-connected-apps-answer-agents-prompts.md) — `answer_prompt`, off until the owner turns it on per app. Amends ADR 0301.
- [0304: The owner hands Clankie's lead to the connected apps](0304-the-owner-hands-the-lead-to-connected-apps.md) — `clankie connector lead apps` holds his own turns for the apps' `read_inbox`; only the owner hands it back.
- [0305: Connected apps write the owner's issues as agents](0305-connected-apps-write-issues-as-agents.md) — `save_issue` and `comment_issue` pass the project's posting setting; issue files are written right away. Amends ADR 0301.
- [0306: A hire never waits on its start checkout](0306-a-hire-never-waits-on-its-start-checkout.md) — a dirty, diverged or pane-owned start checkout is left alone and the hire gets a fresh `origin/main` worktree in its `.local`.
- [0307: A connector reads only a live agent's own output](0307-a-connector-reads-only-a-live-agents-own-output.md) — `terminal_read` refuses panes without a live coding agent and returns only history since its occupant was first read. Amends ADR 0301.
- [0308: Watch is the step below Off](0308-watch-is-the-step-below-off.md) — `autonomy.watch` reads sessions and changes nothing: no model turn, machines act at Portal, no tracker write. Older clients read Off.
- [0309: The real app runs on every change](0309-the-real-app-runs-on-every-change.md) — `pnpm real-run` starts the real service, relay and his own Herdr in a scratch home and checks the owner's key flows; the Mac runs it on every change. Extends ADR 0221.
- [0310: CI is a checkpoint, not a wait](0310-ci-is-a-checkpoint-not-a-wait.md) — drafts get quick checks per push, ready pull requests run the full gate once, failures main already has warn instead of block, and the typecheck starts warm. Amends ADR 0240.
- [0311: The doorway's source is public](0311-the-doorway-source-is-public.md) — the gateway lives in `apps/gateway`; deployment, accounts and records stay in `clankie-ops`, and only the Claude connector route is plaintext at the gateway. Amends ADR 0183.
- [0312: A cleared session is rediscovered, and the connector's detection is the owner's](0312-a-cleared-session-is-rediscovered.md) — one operator redelivery after a cleared or restarted Herdr session, and `clankie connector detect` / `serve`. The multiplexer switch is a list of adapters; Herdr is the first. Amends ADR 0301; narrows ADR 0207 when Herdr detection is on.
- [0313: The connector can read what the fleet can afford](0313-the-connector-can-read-what-the-fleet-can-afford.md) — read-only `fleet_capacity`: plans, usage, permits, tracker budgets and live context, with `"unknown"` where Clankie has no number. Amends ADR 0301.
- [0314: Setup adds the phone and the tailnet](0314-setup-adds-the-phone-and-the-tailnet.md) — the Mac app may mint an ordinary pairing offer with a drawable QR, and discovery lists Herdr machines on the owner's tailnet, trusting Tailscale's host keys only when the owner adds one.
- [0315: Connected apps pass images to and from agents](0315-connected-apps-pass-images-to-and-from-agents.md) — `message_agent` images become owner attachments in the agent's workspace; `read_image` returns one PNG, JPEG, GIF or WebP inside a local seat's working directory. Amends ADR 0301 and ADR 0174.
- [0316: Files reach agents on linked machines](0316-files-reach-agents-on-linked-machines.md) — owner attachments and connected apps' images reach seats on the PCs by `scp` into a checked `.clankie/inbox/`, and `read_image` reads one back through a contained command there, when the machine's access is Workers or above. Amends ADR 0209 and ADR 0315.
- [0317: A Claude hire loads its worker plugin for that session only](0317-a-claude-hire-loads-its-worker-plugin-for-that-session.md) — `--plugin-dir` from Clankie's own files, `plugin:clankie-worker@inline`, one managed-policy entry per machine; nothing installed in a profile. Amends ADR 0187.
- [0318: Discord participants have their own character session](0318-discord-participants-have-their-own-character-session.md) — automatic creation and reuse, native owner permission prompts, and a reply-only public channel.
- [0319: Hires run in the Herdr desktop app's terminals](0319-hires-run-in-the-desktop-apps-terminals.md) — where the desktop app's core runs, hires start as labeled `terminal.run` terminals in one Clankie space, keyed by core address, with Clankie naming the session; Mac first, then the PCs through the core. Amends ADR 0187 and ADR 0301.
- [0320: Setup starts with one read-only agent](0320-setup-starts-with-one-read-only-agent.md) — after the Herdr session, setup can hire one Claude agent in its read-only mode; it reports one proposal, the owner approves it line by line, and Watch steps aside only while it works. Amends ADR 0308 and ADR 0314.
- [0321: The roster says who started each agent](0321-the-roster-says-who-started-each-agent.md) — a hire records whether the owner, a connected app or Clankie asked for it, and the roster says so with `includeStarters=true`; display only, no starter outranks another.
- [0322: An open worker question keeps reaching a lead](0322-an-open-worker-question-keeps-reaching-a-lead.md) — a question no lead took is retried and an unanswered one repeated to whoever leads the hire now, within the hook wait; the first answer wins and a later one is told why. Builds on ADR 0246.
- [0323: Connected apps press keys in agents' terminals](0323-connected-apps-press-keys-in-agents-terminals.md) — `press_keys` presses named keys (arrows, esc, ctrl+c, tab, enter) in a Herdr pane on any machine or a desktop-app hire, whatever the agent is doing, under the same per-app switch as `answer_prompt`; never text. Amends ADR 0303 and ADR 0319.
- [0324: A lead reads how fast the fleet spends](0324-a-lead-reads-how-fast-the-fleet-spends.md) — `fleet_capacity` gains `burn`: each account window's recent and average percent per hour against the pace that uses it all by reset, the projection at reset, and the last hour's tokens per local Claude session named by agent id. Amends ADR 0313.
- [0326: The last hosted leftovers are removed](0326-the-last-hosted-leftovers-are-removed.md) — the Clankie mailbox, the wake-key route, browser-session pairing and `discord.officialBotEnabled` go; older settings and event logs still load. Supersedes ADR 0242.
- [0325: The captain splits by domain without changing behaviour](0325-the-captain-splits-by-domain-without-changing-behaviour.md) — `createCaptain` moves out one domain per pull request into `captain-*.ts` factories with typed contexts and getters for late state, as text with no behaviour change, leaves first; fleet observation then hosts the Effect pilot.
- [0327: Effect pilot on fleet observation](0327-effect-pilot-on-fleet-observation.md) — `readFleet`'s source reads use Effect behind the same API and diagnostics; the measurements of what Effect bought and cost decide whether it goes further.
- [0328: Clankie is a core with extensions](0328-clankie-is-a-core-with-extensions.md) — the fleet, reports, issues, the MCP and CLI, settings and trust are core; the Discord persona, voice, World, games, Watch, each tracker adapter, the relay, computer use, the browser and media become extensions behind one contract that can be left out or fail without taking the fleet down. Proposed; whether the persona is core is open. Extends ADR 0234.
- [0329: Codex reviews on the owner's Mac, and builds run in local workers](0329-codex-reviews-on-the-owners-mac.md) — a Codex worker on the Mac posts one "Codex review" per round under the owner's `gh` login and sets `codex-clean` on the exact head; `codex-review.mjs land` merges only on it; the cloud review is off; each task builds in its own local worker. Amends ADR 0310.
- [0330: Effect rolls out module by module](0330-effect-rolls-out-module-by-module.md) — after the pilot, Effect goes further one whole module at a time as the captain split and the core/extension work touch each one, with one explicit seam to plain `async` per module and no behaviour change. Extends ADR 0325.
- [0331: Clankie settles a hire whose agent is gone](0331-clankie-settles-a-hire-whose-agent-is-gone.md) — before a new hire at a place on this machine, an earlier unresolved hire there whose recorded pane is gone or holds no harness is settled as abandoned from the complete inventory, as the owner's settlement would; running, unrecorded, fresh and remote hires still wait for the owner. Amends VUH-2243.
- [0332: Clankie's own pull requests merge on green checks](0332-clankies-own-pull-requests-merge-on-green-checks.md) — the Clankie project's own setting for clankie, clankie-app and clankie-ops: a ready pull request merges once `check` and `real-run` are green, the landing gate runs on main after the merge, and a local review by any model is advisory with its findings filed as follow-up issues. One project's choice; in the product the owner picks their review pipeline. Supersedes the review gate of ADR 0329.
- [0333: OpenCode 2 hires run a private server](0333-opencode-2-hires-run-a-private-server.md) — on an installed OpenCode 2 a hire takes the V2 plugin and runs `opencode --standalone`, so its server is the TUI's own child, not the owner's shared service; messages enter the session inbox with `steer` or `queue` and a client id, whose admission is the receipt. Amends the OpenCode worker rule of one native TUI and no second server.
- [0334: Herdr direct prompting is the fallback for an agent with no channel](0334-herdr-direct-prompting-is-the-fallback.md) — an owner's or lead's message to an agent with no harness channel, Codex queue or hook receiver is typed through `herdr agent prompt` only while it is idle, its input line reads empty and its session is readable, then confirmed by a new user turn in that session; peers, chosen modes and the desktop app never type. Amends ADR 0207.
- [0335: Connected apps post under "Clankie decides" without waking him](0335-connected-apps-post-under-clankie-decides.md) — on Clankie decides, a connected app's `save_issue` and `comment_issue` post like Clankie's own writes, whoever leads, and wake no conversation; workers' writes and drops still wait for Clankie. Amends ADR 0305.
- [0336: A connected app wakes a lead at its own webhook](0336-a-connected-app-wakes-a-lead-at-its-webhook.md) — the owner stores a connected lead's wake webhook (address and key, from stdin) in the credential broker with `clankie connector wake set NAME`; the connector's `wake_lead` and `clankie connector wake send` POST only a job's text and its sender there, and the lead answers on the notes board. Builds on ADR 0301 and ADR 0304.
- [0337: Hand-opened OpenCode 2 sessions take messages through the shared service](0337-hand-opened-opencode-2-sessions-take-messages-through-the-shared-service.md) — `clankie harness opencode install` adds Herdr's own OpenCode plugin, which reports each pane's session; Clankie then admits a message into that session's inbox on OpenCode 2's shared service as steer or queue, only after proving the pane's TUI holds a connection to that service. The inbox item is the receipt, and the service password never leaves the request.
- [0338: Outside extensions plug into the same contract](0338-outside-extensions-plug-into-the-same-contract.md) — other people's extensions are a folder or pinned git/npm package exporting `ClankieExtension` plus a manifest; the owner adds each one, grants or refuses each port it asks for, and switches it like a built-in; no machine authority above the ceiling, and in-process code is trusted, not sandboxed. A listing is a reviewed git repository of pinned entries, with nothing to host. First step: a frozen outside contract, a public SDK and one loader, proven by Rivals. Accepted: James chose trusted in-process add-ons now, with a sandbox required before any unreviewed listing. Extends ADR 0328 and ADR 0234.
- [0339: Connected apps close finished hires](0339-connected-apps-close-finished-hires.md) — the connector's `close_agent` closes a seat only when its hire record says Clankie or a connected app started it, it reads idle or done (read again just before the exit), and its unlanded work holds as `close_seat`'s does; the relay stamps the app, every close is logged, and nothing brings a window forward. Amends ADR 0301 and ADR 0321.
