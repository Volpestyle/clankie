# Owner settings inventory

This page lists every setting an owner can change, which API stores it, and
which surfaces can set it today. It is the baseline for the "every UI" rule in
`AGENTS.md` (VUH-1813): a setting the owner cares about must be settable from
the TUI, the app (phone, web and desktop) and the hosted dashboard through the
same API. Settings that only make sense on one surface are marked
**single-surface**, with the reason.

Audited 2026-10-07 against clankie `6f165578`, clankie-app `3068dd9` and
clankie-ops `244e4de`. Core follow-up on 2026-10-07 adds host writes and moves
fleet, persona, voice, Discord fields, holds and Linear follow/wake onto owner
APIs; app/dashboard controls remain separate work. When a surface or route
changes, update this page.

## How to read it

- **Tier.** **Common**: the owner changes it; keep it up front. **Advanced**:
  sensible default, behind an Advanced disclosure. **Single**: single-surface by
  nature.
- **API.** The HTTP route that owns the value. "None" means no API writes it.
  Then the value lives only in `~/.config/clankie/settings.json`, and only local
  tools can change it.
- **Surfaces.** **CLI**/**TUI** are the local `clankie` commands and console.
  **App** is clankie-app. **Dash** is the hosted account page
  (`clankie-ops/apps/fleet/web`).
  - ✓ sets it through the API.
  - **file**: the local CLI or TUI writes `settings.json` directly instead of
    calling the API.
  - **view**: read-only.
  - **adv**: only reachable as a raw field in a generic Advanced list.
  - **off**: built but shipped disabled.
  - **—**: absent.

### How each surface reaches the API

- **App and hosted console.** They reach a body through the public gateway.
  Owner settings ride one of two paths:
  - the relay's settings projection (`apps/relay/src/operator-conversations.ts`,
    `OPERATOR_RELAY_DEVICE_ROUTES`, which needs the `terminalControl` grant);
  - the hosted operator bridge (`hostedOperatorAllows` in
    `packages/protocol/src/hosted-operator.ts`).

  A route missing from both lists is unreachable from a phone, even though it
  exists on the body.

- **Local CLI and TUI.** Fleet, persona, voice, Discord fields, worker-account
  holds and Linear follow/wake use the same owner API as devices, including
  revision fences. Host availability settings also use the owner API. A stale
  write is refused without retry. Machine bootstrap exceptions are listed in
  [ADR 0248](adr/0248-owner-settings-use-one-revision-fenced-api.md).
- **Discord settings.** These are the only settings with a host-supplied
  definition (`DISCORD_SETUP_DEFINITION`, ADR 0222): labels, help and choice
  labels come from `@clankie/protocol`. Every other domain uses typed snapshots.

## Inventory

### 1. How he talks: Discord attention

| Setting                                                        | Values (default)                                                    | API                                                                                             | CLI | TUI                                                  | App                                                       | Dash                                                        | Tier     |
| -------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --- | ---------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| What wakes him in text, `discord.wakeTrigger`                  | `mention` / `name` / `any`; unset is the body default (7d7f9485)    | `POST /v1/discord/settings`                                                                     | ✓   | ✓ `/discord` → "What wakes him / how much he talks"  | ✓ "What wakes him / how much he talks", including Default | off: free official bot card only; edge not deployed in prod | Common   |
| How readily he jumps in, `persona.chattiness`                  | `quiet` / `balanced` / `chatty` (balanced)                          | `GET`/`POST /v1/operator/persona`; hosted bridge, and relayed for talkativeness only (669b2946) | ✓   | ✓ `/persona`, `/discord`; hosted console ✓           | ✓ same card                                               | —                                                           | Common   |
| Reply policy, `persona.replyPolicy`                            | `all` / `addressed` (all); voice, and text when the wake is default | same                                                                                            | ✓   | ✓ `/persona`, `/discord`                             | ✓ same card, under More                                   | —                                                           | Advanced |
| Name, aliases, character notes, persona images                 | text                                                                | same                                                                                            | ✓   | ✓ `/persona`; hosted console ✓ (name, notes, images) | —                                                         | —                                                           | Advanced |
| Live message window, `persona.liveMessageWindow`               | 0–100 (5)                                                           | same                                                                                            | ✓   | file                                                 | —                                                         | —                                                           | Advanced |
| Channels he follows between wakes, `discord.ambientChannelIds` | channel ids                                                         | `POST /v1/discord/settings`; ops edge for hosted and official bots                              | ✓   | ✓ Advanced                                           | adv                                                       | off (free-bot card)                                         | Advanced |

### 2. Where he lives: Discord server

| Setting                                                                                                                                         | Values (default)                                                    | API                                                   | CLI                                 | TUI                       | App              | Dash                                    | Tier     |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- | ------------------------- | ---------------- | --------------------------------------- | -------- |
| Server, `discord.serverId`                                                                                                                      | directory pick                                                      | `POST /v1/discord/settings` (operator; hosted bridge) | ✓ `setup`                           | ✓ `/discord`              | ✓ setup sentence | off (VUH-1689)                          | Common   |
| His role, `discord.role`                                                                                                                        | `participant` / `admin` (participant)                               | same                                                  | ✓                                   | ✓                         | ✓                | off                                     | Common   |
| Fleet in Discord, `discord.fleetEnabled`                                                                                                        | bool (false)                                                        | same                                                  | ✓                                   | ✓                         | ✓                | off                                     | Common   |
| Project tracking, `discord.trackingLevel`                                                                                                       | `off` / `project_updates` / `project_activity` / `all_issues` (off) | same                                                  | ✓                                   | ✓                         | ✓                | off                                     | Common   |
| Official Clankie bot, `discord.officialBotEnabled`                                                                                              | bool (false)                                                        | `GET`/`POST /v1/discord/official`                     | ✓                                   | ✓                         | ✓                | ✓ (free card; ops edge)                 | Common   |
| Owners per server, `discord.servers`                                                                                                            | Just me / Everyone / Discord role; Participant / Admin              | `GET`/`POST /v1/discord/settings` (revision-fenced)   | ✓ `discord owners`                  | ✓ `/discord`              | ✓ (VUH-1835)     | ✓ source (VUH-1836); rollout pending    | Common   |
| A room can use a skill, `discord.roomSkills`                                                                                                    | House hunting / off                                                 | same                                                  | ✓ `discord room-skill`              | ✓ `/discord`              | ✓ (VUH-1835)     | ✓ source (VUH-1836); rollout pending    | Common   |
| Legacy household authors, `discord.houseHuntingAuthorBindings`                                                                                  | exact household/label/Discord ID; each owner-confirmed (empty)      | same                                                  | ✓ `discord legacy-author --confirm` | ✓ Advanced, confirms each | ✓ Advanced JSON  | ✓ Advanced JSON; hosted rollout pending | Advanced |
| Individual machine grants (compatibility), `discord.systemActorUserIds`                                                                         | user IDs                                                            | same                                                  | ✓ `discord set`                     | ✓ Advanced                | adv              | —                                       | Advanced |
| Text ingress, DM policy, context messages, presence, tool-progress rooms, voice join/consent, transcript logging, active body, user-session lab | see `DiscordSettingsSchema`                                         | `POST /v1/discord/settings`                           | file                                | ✓ Advanced                | adv              | off                                     | Advanced |

### 3. His mind: model and voice

| Setting                                | Values (default)          | API                                               | CLI  | TUI                                | App     | Dash                    | Tier     |
| -------------------------------------- | ------------------------- | ------------------------------------------------- | ---- | ---------------------------------- | ------- | ----------------------- | -------- |
| Captain model and thinking effort      | catalog; `off` to `max`   | `/v1/model-keys/select`, `/v1/model-keys/effort`  | file | file `/model`, `/effort`; hosted ✓ | ✓ Model | view ("set in the app") | Common   |
| Model keys and subscriptions           | write-only keys           | `/v1/model-keys/*`                                | file | ✓                                  | ✓       | —                       | Common   |
| Image/video model, compaction, routing |                           | none (`clankie.json`)                             | file | file                               | —       | —                       | Advanced |
| Voice brain and TTS (`voice.*`)        | providers, models, voices | `GET`/`POST /v1/operator/voice` (relayed, fenced) | ✓    | ✓ `/voice`                         | —       | —                       | Advanced |

### 4. How the fleet works

| Setting                                                                                           | Values (default)                                             | API                                                                        | CLI           | TUI                             | App                                       | Dash | Tier     |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------- | ------------------------------- | ----------------------------------------- | ---- | -------- |
| Fleet size, `fleet.size`                                                                          | `max` / `large` / `small` / `solo` (max)                     | `GET`/`POST /v1/operator/fleet-settings` (relayed, bridged)                | ✓             | ✓ `/fleet`; hosted console view | ✓ Fleet                                   | —    | Common   |
| Model choices, `fleet.models`                                                                     | `optimal` / `efficient` (optimal)                            | same                                                                       | ✓             | ✓                               | ✓                                         | —    | Common   |
| Working preferences: commit, push, release, verification, reporting style, closure, machine setup | `lead` / `owner` / time rule (ADR 0230)                      | same                                                                       | ✓             | ✓                               | ✓                                         | —    | Common   |
| Hire defaults: harness, model, effort (`fleet.hire`)                                              | "No preference" (`auto`, never stored; ea54ebd6), or a value | `GET`/`POST /v1/operator/fleet-settings/hire` (relayed, bridged; 669b2946) | ✓ `fleet set` | ✓ `/fleet`                      | ✓ Fleet → Who he hires (model under More) | —    | Common   |
| Hire defaults: account, subagents, delegation, placement                                          | same profile                                                 | fleet-settings                                                             | ✓             | ✓                               | —                                         | —    | Advanced |
| Connected tools for workers, peer messages, fleet notes                                           | `connected`/`off`, `on`/`off`, text                          | fleet-settings                                                             | ✓             | ✓                               | —                                         | —    | Advanced |
| Shared resources (heavy and simulator slots, load, memory)                                        | `FleetResourcePolicySchema`                                  | fleet-settings                                                             | ✓             | ✓ `/fleet resources`            | —                                         | —    | Advanced |

### 5. Projects

| Setting                                                                                   | API                                                    | CLI | TUI          | App                                                        | Dash | Tier     |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------ | --- | ------------ | ---------------------------------------------------------- | ---- | -------- |
| Name, agent limit, tracker workspace, roles (name, model, effort, cap), autonomy override | `GET /v1/operator/projects`, `POST …/update` (relayed) | ✓   | ✓ `/project` | ✓ Project; role harness not editable; effort lacks `ultra` | —    | Common   |
| Role harness and account; "no preference"                                                 | same                                                   | ✓   | ✓            | — (kept from the original)                                 | —    | Advanced |
| Project fleet size/models override                                                        | create only; not in the update schema                  | ✓   | ✓            | —                                                          | —    | Advanced |
| Workspaces, worktree roots                                                                | `POST …/remove-workspace`, `…/add-worktree-root`       | ✓   | ✓            | —                                                          | —    | Advanced |

### 6. Worker accounts

| Setting                                                                      | API                                                           | CLI                       | TUI                        | App                             | Dash | Tier                                           |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------- | -------------------------- | ------------------------------- | ---- | ---------------------------------------------- |
| Accounts per machine (identity, plan, headroom, usable), read                | `GET /v1/worker-accounts?fleet=` (relayed, bridged; 669b2946) | ✓ `accounts workers`      | ✓ `/accounts` → by machine | ✓ Worker accounts, per computer | —    | Common                                         |
| Hold or release an account, `workerAccountHolds`                             | `GET`/`POST /v1/worker-accounts/holds` (revision-fenced)      | ✓ `accounts hold/release` | ✓ `/accounts`              | ✓ Set aside / Use again         | —    | Common                                         |
| Sign a coding agent in (Take Control)                                        | `/v1/harness-logins/*`                                        | ✓                         | ✓                          | ✓ Coding agents                 | —    | Common                                         |
| Register Claude profiles and Codex homes (`claudeAccounts`, `codexAccounts`) | none                                                          | file                      | file                       | —                               | —    | Single: local filesystem paths on that machine |

### 7. Connections

| Setting                                          | API                                                                                      | CLI  | TUI                   | App        | Dash                     | Tier                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---- | --------------------- | ---------- | ------------------------ | ----------------------------------- |
| GitHub, Linear, Google (Gmail, Calendar, Drive)  | `/v1/accounts/*` (bridged, control plane)                                                | ✓    | ✓ `/connect`          | ✓ Accounts | ✓ (needs a running body) | Common                              |
| Email (Clankie mailbox or IMAP/SMTP)             | none                                                                                     | file | file `/connect email` | —          | —                        | Advanced                            |
| Linear follow and wake rules (`linearWebhook.*`) | `GET`/`POST /v1/linear/follow\|wake` (relayed, fenced); target/routes retain `GET`/`PUT` | ✓    | ✓ `/linear`           | —          | —                        | Advanced                            |
| Worker access grants                             | `/v1/worker-grants/*`                                                                    | ✓    | ✓ `/access`           | —          | —                        | Advanced                            |
| OAuth app client ids and secrets                 | none                                                                                     | file | file                  | —          | —                        | Single: self-hosted developer setup |
| MCP servers (`mcp.servers`)                      | none                                                                                     | —    | —                     | —          | —                        | Advanced (file only today)          |

### 8. Machines and availability

| Setting                                          | API                                                                          | CLI                            | TUI                       | App                                   | Dash | Tier                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------ | ------------------------- | ------------------------------------- | ---- | ----------------------------------------------------- |
| Machines and runtime connections, capacity       | `/v1/machines`, `/v1/runtime-connections` (bridged); dispatch `connections`  | ✓                              | ✓ `/machines`, `/runtime` | ✓ Machines                            | —    | Common                                                |
| Machine access, `machineAccess`                  | `PATCH /v1/machines/:id/access`; paired `connections` / `set_machine_access` | ✓ `machines access NAME LEVEL` | ✓ Settings → Machines     | API ready; UI pending                 | —    | Common; portal/workers/shell/screen                   |
| Keep the Mac awake, `host.keepAwake`             | `GET`/`POST /v1/operator/host-settings` (relayed, fenced)                    | ✓ `awake on/off`               | ✓ `/awake`                | ✓ Keeping Clankie available           | —    | Common on a self-hosted Mac                           |
| Install updates automatically, `host.autoUpdate` | same; managed hosting keeps it enabled                                       | ✓ `update auto`                | ✓ `/update`               | ✓ same; locked on for managed hosting | —    | Advanced                                              |
| Hosted machine wake and sleep                    | ops `/fleet/v1/wake`, `/sleep`                                               | —                              | —                         | —                                     | ✓    | Single: hosted lifecycle belongs to the control plane |
| Update canary policy, runtime-health alerts      | `/v1/runtime-update/canary`; `/v1/operator/runtime-health` (bridged)         | ✓                              | ✓                         | —                                     | —    | Advanced                                              |
| Herdr runtime, captain working directory         | none                                                                         | file                           | file                      | —                                     | —    | Single: local machine wiring                          |

### 9. Devices, privacy and support

| Setting                                                  | API                                                   | CLI  | TUI  | App               | Dash                  | Tier                                         |
| -------------------------------------------------------- | ----------------------------------------------------- | ---- | ---- | ----------------- | --------------------- | -------------------------------------------- |
| Paired devices (list, revoke)                            | `/v1/devices`, `/v1/devices/:id/revoke`               | ✓    | ✓    | ✓ Devices         | — (points to the app) | Common                                       |
| Notifications on this device                             | device push binding                                   | —    | —    | ✓ This device     | —                     | Single: per device OS permission             |
| Share diagnostics (account default; per-device override) | ops `/fleet/v1/settings/diagnostics`; device override | —    | —    | ✓ device override | ✓ account default     | Single: account default lives on the account |
| Support access grants                                    | `/v1/support/grants` (bridged)                        | ✓    | ✓    | ✓ Support         | ✓                     | Advanced                                     |
| Browser session recording, desktop quiet hours           | none                                                  | file | file | —                 | —                     | Advanced                                     |

### 10. Play

| Setting                                | API                                     | CLI  | TUI                      | App | Dash | Tier     |
| -------------------------------------- | --------------------------------------- | ---- | ------------------------ | --- | ---- | -------- |
| Games (PokeAgent MMO, budgets), Rivals | `GET`/`PUT /v1/games/configuration`     | file | file `/games`, `/rivals` | —   | —    | Advanced |
| Minecraft play, profiles, allowlist    | `GET`/`PUT /v1/minecraft/configuration` | file | ✓ `/minecraft`           | —   | —    | Advanced |

### 11. Account and billing (hosted only)

These live only on the hosted account page, and should stay there. Plan
changes, payment cards, invoices, credit top-ups, overage caps, account
deletion and sign-out all pass through Stripe or Cognito. The app shows
credits read-only.

Discord ownership and room-skill controls in **clankie-app** (including its web/desktop surfaces, [VUH-1835](https://linear.app/vuhlp/issue/VUH-1835)) and **clankie-ops hosted dashboard** ([VUH-1836](https://linear.app/vuhlp/issue/VUH-1836)) are named follow-ups to VUH-1831. Core API, CLI and TUI ship together; older clients preserve these settings on unrelated saves.

## Gaps, ranked by what the owner cares about

> **Status 2026-10-07.** Gaps 1–4 are closed in core (`669b2946`, ADR 0248)
> and the app (clankie-app `72bb526`…`88800dc`, iPhone captures in that
> repo's `docs/testing/2026-10-07-vuh-1813-settings-parity/`). Still open:
> the hosted dashboard for these settings (gap 5), the app hire page's `pi`
> default harness, and iPad layout under VUH-1810. The history below records
> the gaps as found.

1. **Discord attention in the app.**
   - The app has no chattiness or reply policy, and the wake trigger appears
     only as a raw Advanced chip that cannot go back to the body default.
   - The relay does not carry `/v1/operator/persona`.
   - The dashboard's wake selector exists only on the free-bot card, and the
     edge it needs is not deployed in production (VUH-1765, VUH-1689).
   - The labels live only in the TUI (`WAKE_TRIGGER_LABELS`,
     `CHATTINESS_LABELS`), not in `@clankie/protocol`.
2. **Fleet hire defaults (harness, model, effort, "no preference").**
   - No API writes `fleet.hire`; only the local CLI and TUI can.
   - The app's hire page also defaults the harness to `pi` instead of "no
     preference".
3. **Worker account holds.**
   - No API holds or releases an account, and `GET /v1/worker-accounts` is not
     relayed, so the app cannot even read it.
4. **Host availability core gap resolved.**
   - Revision-fenced host write APIs and device forwarding now exist for
     `host.keepAwake` and `host.autoUpdate`, with shared protocol wording.
   - The app binds both switches under Keeping Clankie available.
5. **Hosted dashboard Discord settings** are built but off (VUH-1689), and its
   Model section is view-only.
6. **Core owner paths unified.** Fleet, persona, voice, Discord `set`, holds
   and Linear follow/wake now read and write the owner API. Every update uses
   the returned revision; conflicts require a fresh read and review.
   - First-run machine wiring, local account profile registration, provider
     credentials and the signed webhook URL remain separate setup operations.
   - See [ADR 0248](adr/0248-owner-settings-use-one-revision-fenced-api.md).
7. **Voice brain, Linear follow and wake, email:** app controls remain follow-up
   work. Voice and follow/wake routes are now relayed; email still has no API.
8. **Project details:**
   - The fleet size/models override can't be changed after a project is
     created.
   - The app can't edit a role's harness and omits the `ultra` effort.
9. **Guidance text outside protocol.**
   - `FLEET_SIZE_GUIDANCE` and `FLEET_MODEL_GUIDANCE` live in
     `@clankie/settings`, so the app writes its own copy.
10. **Planned settings that must land at parity from the start:**
    - VUH-1782 gates ("Just do it / Clankie decides / Ask me" plus presets),
      with the VUH-1809 mailbox following those gates.
    - Web (VUH-1793) and desktop (VUH-1791) inherit the app's settings.

## Grouping the app should converge on

These groups mirror the inventory sections above, so each one covers a single
concern:

1. How he talks
2. Where he lives (Discord)
3. His mind
4. How the fleet works (worker accounts appear here too)
5. Projects
6. Connections
7. Machines
8. Devices and privacy

Within each group, the Common rows come first and everything else goes behind
Advanced. Play and the raw Discord fields stay under Advanced.
