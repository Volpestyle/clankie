# VUH-1622: Discord server roles and projections

[Issue](https://linear.app/vuhlp/issue/VUH-1622) ·
[role decision](../../adr/0226-discord-connects-a-server-with-a-role.md) ·
[setup contract](../../cli.md#discord-setup)

The core is ready for Pell's integration batch on `feat/vuh-1622` in
`~/dev/clankie-wt/vuh-1622`. This evidence covers local code and HTTP contracts,
not live Discord grants. No live messages, bot/application changes, sign-ins or
account changes were performed. James moved the issue to In Progress while
the Linear bridge was timing out.

## Delivered core

- One connected server and Participant/Admin role, independent fleet on/off and
  four tracking levels. The shared API definition and CLI/TUI setup show these
  controls; raw IDs and machine grants remain Advanced. Normal setup queries
  only the server directory, without channel, Discord-role or person pickers.
- Participant invite requests the normal member grants; Admin requests
  Administrator. Setup checks every requested permission and distinguishes
  denied grants from missing evidence. A role grants no machine access.
- Native server actions enforce the connected server and resource membership.
  Admin can create/place/delete channels, archive threads, and manage categories,
  roles, webhooks and members. Server deletion and ownership transfer are refused.
  Participant projection messages use only its designated channel; Discord
  permissions govern ordinary conversation and voice.
- Admin fleet groups acquire a destination on their first message. Persisted
  credentials survive off/on and restart. Participant needs no fleet webhook.
  Saved authority is read before effects; cleanup cannot use an old webhook to
  bypass a changed role/server. An uncertain automatic creation is never replayed.
- A production bot integration pauses the native membership read, revokes Admin
  in the saved settings, then releases the read. The pending mutation refuses
  and sends no POST to the local REST service.
- Signed Linear events route through already registered project trackers in the
  verified workspace, including any saved label restriction. Admin has a channel
  or forum per tracked project and one thread/post per issue. Clankie can choose
  representation before the first event. Tracking works independently of fleet;
  off retains destinations. Comments without a project require canonical issue
  lookup, so moving an issue does not reuse its old project mirror. Delivery
  receipts and uncertain writes persist across restart.
- Lead review privacy fix: every new project text channel/forum denies
  `VIEW_CHANNEL` to `@everyone` and allows the actual Clankie member from the
  authenticated body's permission cache. Unknown/mismatched identity or denied
  Administrator leaves the event pending without a Discord write. The tests
  assert both representations' overwrites. Announcement-follow destinations
  are included in the connected-server reference checks. Project-mirror tools
  use the captain's injected settings store and explicit environment.

## Focused checks

The new integration scenarios use real temporary settings/tracker files,
protocol schemas, signed webhook HTTP, body HTTP and the native role executor
against a local REST contract service. The fleet scenario uses the real
ConversationStore and restarts it against the same durable metadata.

```sh
pnpm exec vitest run apps/clankie/test/discord-server-role.integration.test.ts apps/clankie/test/discord-tracking.integration.test.ts
pnpm exec vitest run apps/tui/test/discord-setup-integration.test.ts apps/tui/test/discord-commands.test.ts apps/clankie/test/discord-settings-definition.test.ts apps/clankie/test/discord-setup-permissions.integration.test.ts
pnpm exec vitest run apps/clankie/test/channel-projection.test.ts apps/clankie/test/operator-conversation-channel.test.ts
pnpm exec vitest run packages/discord-presence-core/test/captain-action-control.test.ts apps/discord-bridge/test/presence-runtime-module.test.ts apps/clankie/test/discord-captain-actions.test.ts
pnpm exec vitest run apps/discord-bridge/test/directory-integration.test.ts apps/clankie/test/discord-room-routes.test.ts
```

Role/tracking: **10 passed**. Setup: **29 passed**. Existing fleet/conversation checks: **30 passed**.
Captain/body checks: **16 passed**. Directory/API checks: **10 passed**.
Total: **95 tests in 13 files**. Results were collected in focused batches;
unchanged checks were reused rather than running a full suite.

Focused typechecks cover protocol, settings, API client, presence core, bot,
lab user session, TUI and service. Changed-file lint/format, local Markdown links,
retired claims and `git diff --check` also pass.
No full `pnpm check`, release build or eval was run; Pell owns batch gates.

## Exact live checks for James

Use the official bot body for Admin. These steps are for James after the core
is integrated and running; they authorize no live execution by this worker.

1. Open TUI `/discord`. Confirm the normal controls are server/role, fleet,
   tracking, plus invitation and setup evidence. Confirm channel/role/person
   pickers and raw IDs are absent. Run `clankie discord setup invite --role admin`
   and inspect the generated invite: `permissions=8`. James invites the bot to
   **Oathkeeper**, then runs
   `clankie discord setup connect --server Oathkeeper --role admin` and
   `clankie discord setup check`. Apply the body's documented restart if setup
   reports it is needed. Administrator should be proven. James temporarily
   removes that grant, checks **needs Administrator**, restores it and checks
   again. No gateway evidence should produce **not checked**, not success.
2. In Oathkeeper, ask Clankie to create a temporary category and text channel,
   place/reorder the channel there, create a forum and issue post, and archive
   the post. Ask him to create a temporary role/webhook and manage an expendable
   test member below his role. Confirm these actions proceed without an approval
   prompt and respect Discord's actual hierarchy. Ask him to delete a temporary
   channel: this is allowed. Ask him to delete the server or transfer ownership:
   both must be refused and produce no corresponding Discord mutation.
3. Set `clankie discord setup fleet --enabled on`. Send one message in an
   existing local fleet group with no projection. Confirm one channel/webhook is
   made and the group appears there. Send a second message: no second destination.
   Turn fleet off, then send a group message: no Discord post or webhook deletion.
   Turn it on and restart: the original destination resumes. Change role/server
   before explicitly disconnecting a group: old webhook cleanup must not escape
   the current authority.
4. For a saved Linear project tracker in the connected workspace, ask Clankie
   to choose a forum with `discord_tracking_project` before its first delivery.
   Verify a normal `@everyone` member cannot view the resulting forum or a
   tracking text channel; Clankie's member and server administrators can.
   Clankie can deliberately admit the appropriate people afterward.
   Set tracking to `off`; create a project update and issue activity: no posts.
   Select `project_updates`: a new project update posts, while a new issue and
   issue comment do not. Select `project_activity`: verify a milestone, project
   status change, new issue, ordinary issue status change and completed issue
   post; a plain comment does not. Select `all_issues`: edit/comment on an issue;
   the same issue post receives subsequent notifications. Another issue gets
   one new post. A project outside the saved tracker or its label restriction
   must not post. Move an issue outside the tracked project and comment: it must
   not post in the old mirror. Repeat off/on and service restart: no duplicate
   project/issue destinations or replay of an unconfirmed write. Check a second
   project with channel representation too.
5. Generate `clankie discord setup invite --role participant`; verify it requests
   normal text/thread/voice grants, without Administrator or management grants.
   James invites/connects **Blinkercity** with
   `clankie discord setup connect --server Blinkercity --role participant`.
   Run the setup check and deliberately remove/restore one normal grant to verify
   **needs**. Create a channel overwrite that denies viewing, sending or voice
   joining: Clankie must follow Discord's denial. Verify permitted rooms remain
   available without adding them to a Clankie channel list.
6. Under Advanced, give Participant its existing fleet destination. With fleet
   on, local group messages must go only there and create no channel/webhook.
   Turn fleet off and enable tracking: project updates still post in that given
   channel. Turn tracking off too: no projection posts. A designated channel in
   another server must be refused. Verify ordinary text and consented voice in
   permitted Blinkercity rooms; no role change should grant a machine shell.

## Remaining scope

- App UI is conditional on the core landing cleanly. No app worktree or app
  files were changed. VUH-1645 remains on hold for rescope. App and hosted
  dashboard consumers still need the shared three controls; dashboard UI
  belongs to the private operations repository. The definition now emits schema
  version 2; consumers pinned to version 1 need updating before a coordinated
  release. The new parser accepts versions 1 and 2, and older settings writers
  preserve omitted server-role controls.
- The lab user-session body retains recorded channel-scoped consent. It cannot
  represent full-server Admin authority and refuses that mode. Participant
  retains its existing consent ceiling. A future lab-consent rescope is required
  to support Admin there; the official bot is the implemented Admin path.
- Actual invite acceptance, gateway grants/intents, Discord role hierarchy,
  native REST effects and live Linear webhook subscription coverage remain
  untested here. Uncertain deliveries require inspection; there is no automatic
  deleted-mirror repair or backfill.
- Keep this worker's worktree until its commit is on `origin/main`. Pell owns
  landing and the batch gates. Linear evidence must be posted when its direct
  workspace bridge is reachable; the final handoff carries it meanwhile.
