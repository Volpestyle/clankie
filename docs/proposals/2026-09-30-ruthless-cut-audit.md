# Ruthless cut audit

Status: historical proposal at `2eb2608d` (VUH-1475), not a current inventory or
an instruction to delete features. Later decisions in
[ADR 0203](../adr/0203-clankie-keeps-what-better-models-cannot-absorb.md),
[ADR 0207](../adr/0207-work-records-and-native-agent-delivery.md), and
[ADR 0213](../adr/0213-clankie-retires-swarm.md) retain both Discord bodies,
retire the menu bar and embedded Swarm, and require native agent delivery.
The recommendations and counts below describe the original audit.

Date: 2026-09-30, at `2eb2608d`.

[ADR 0203](../adr/0203-clankie-keeps-what-better-models-cannot-absorb.md) sets the
test. Every feature must (1) bring life or character to Clankie, or (2) give the
owner something the Claude Code and Codex ecosystems don't, and still be needed if
Claude and Codex were twice as good tomorrow. This audit applies that test to every
app, package, service, captain tool, CLI and TUI command and bundled skill. It reuses
the [Discord surface review](2026-09-30-discord-surface-review.md) (VUH-1460) and
the [2026-09-30 eval baseline](../testing/2026-09-30-eval-baseline/README.md).

## Headline

- **Cut about 25k to 30k lines of about 249k (10–12%)** (source plus tests), in seven
  batches. Apps go from 9 to 7 and packages from 20 to 17. The largest items are the
  user-session lab body (about 7.4k lines), the vendored `herdr-lead` dashboard
  and nine unused process skills (about 6.2k), and a group of features with zero or
  failing use: the evaluator, goals, headless agent sessions and the Linear webhook
  (about 4.4k).
- **Two of the issue's named candidates are smaller than they looked.**
  - _The TUI's 25.9k lines_ are mostly not duplication. About 9.7k lines are the
    `clankie` CLI and the service launcher, which everything depends on. About 5k
    lines are the only place to enter secrets and OAuth logins, or to set up Discord
    and voice. The chat shell (about 4.5k) does overlap the app, but ADR 0203 keeps
    the TUI first-class. What is left to cut is about 1.4k lines: a second hosted
    console, two duplicated command pairs, and slash wrappers nobody has typed.
  - _Terminal-typing control_ is already mostly replaced: the plugin and app-server
    adapters landed today. What remains to cut is about 0.8k lines, once VUH-1458
    and VUH-1459 are verified live.
- **The biggest lever is not in the tables.** Clankie's own pi operator lane (bash,
  read, edit and write on a custom loop) is the part of Clankie that most resembles
  a custom harness, and the Claude Code and Codex seats now do the same job.
  Whether it goes is decision D1 below. I have not counted it in the totals.

## Method and limits

Sources, read for names, counts, types and dates only. No message text, tool
arguments or media were opened. Full tables are summarized in the
[appendix](#appendix-inventory).

- Usage:
  - pi trees and `turn-settled.jsonl` (1,383 settled turns since 2026-08-29);
  - Claude Code transcripts (since 2026-08-31) and 1,271 Codex rollouts;
  - `~/.zsh_history`;
  - the console's prompt history (`.data/tui/prompt-history.jsonl`, 319 slash
    commands, no timestamps);
  - Discord receipts, service logs, relay log and memory stores.

  "30d" means 2026-08-31 to 2026-09-30.

- Size: `wc -l` over tracked `.ts/.tsx/.mjs/.js/.rs/.html/.css`, source and tests
  separately. Figures cover the feature's own files. Wiring in `app.ts`,
  `tools.ts`, protocol schemas and settings is extra, typically 10–20% more.
- Native coverage:
  - Claude Code 2.1.285 and codex-cli 0.159.1 docs and `--help`;
  - the competing products James listed on 2026-09-30:
    - OpenAI Dots: always-on cloud agents with a browser, 4,000+ connectors and an
      avatar;
    - xAI Grok Bot: shared cloud VM, 220 connectors;
    - Meta Muse: an avatar companion.

  None of the three runs on the owner's machine, leads other labs' agents, or does
  Discord voice.

- Dead code: `knip` finds no unused files today (one duplicate export). The cuts
  below are whole features, not stray dead code.

What this cannot show:

- **Agent use is not product use.** Most CLI and tool traffic is agents building
  and testing Clankie. A command with 50 agent calls may have no user.
- **Retention is short.** Transcripts start 2026-08-31, pi trees are pruned, and
  `events.jsonl` is compacted. The prompt history has no dates, so slash-command
  counts are lifetime counts since 2026-07-10.
- **Only this Mac was read.** A hosted body or the Windows PC may use things this
  machine does not.
- **HTTP routes are not logged**, so app-only API use cannot be counted directly.

## How to read the tables

- **Criterion:** L = brings life or character; U = unique to Clankie (Claude Code,
  Codex and the three products don't do it); — = neither.
- **Use:** 30-day count unless marked. "0 ever" means no call in any retained trail.
- **Lines:** source + tests.
- **Covered by:** CC = Claude Code, Cx = Codex, Dots = OpenAI Dots.

Reply with IDs, for example "approve all except C13, C16". Each row names the ADRs
to mark superseded when it lands.

## Cut, fold and keep calls

### Batch 1: dead, failing or zero-use (no product loss)

| ID  | Item                                                                                                                                                                     | Call    | Crit. | Use                                                                              | Lines       | Covered by                                           | Evidence                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ----- | -------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Evaluator: `captain/evaluator.ts`, protocol schema, `clankie evaluator`, `/evaluator`                                                                                    | **Cut** | —     | 864 jobs 09-23..30: **841 failed**, 23 completed; 0 human CLI use                | 0.6k + 0.8k | The A/B eval runner (VUH-1454), `claude plugin eval` | It fails, it fills 2.8 GB on disk, and the eval runner now does this job with real repetitions. ADR 0178.                                                                                     |
| C2  | Goals and the goal decision journal (`create/get/update_goal`, `note_goal_decision`, `/goal`, `/autonomy`). **Keep** `schedule_wake`/`cancel_wake`.                      | **Cut** | —     | Goal tools 0 ever. The journal directory was never created. `/goal` never typed. | ~0.6k       | CC and Cx `/goal`, CC `/loop` and routines           | Waking himself is his own volition (L), so it stays. Goals re-implement a harness loop and nobody used them. Amend ADR 0130, retire ADR 0132.                                                 |
| C3  | Headless agent-session turns: `agent_session_send`/`_run`, the runs routes, `agent-hosts` `turn.ts` and `turn-powershell.ts`. **Keep** list and read.                    | **Cut** | —     | 0 ever                                                                           | ~1.1k       | CC `-p --resume`, Cx `exec resume`                   | ADR 0203 says workers are never replaced by a headless process; this path is exactly that. Reading transcripts stays: ADR 0135, `clankie agents`.                                             |
| C4  | Linear webhook (`linear-webhook.ts` and its route)                                                                                                                       | **Cut** | —     | Last event 09-08: 48 rejections, **0 accepted**                                  | 0.4k + 0.8k | Cx native Linear; the notifications poller           | The notification inbox is what actually wakes him (3,728 messages).                                                                                                                           |
| C5  | Unused terminal-typing members `sendText`, `pressEnter`, `sendKeys` in the Herdr runner                                                                                  | **Cut** | —     | No production caller (only the remote runner's pass-through)                     | ~0.1k       | —                                                    | Verified by grep.                                                                                                                                                                             |
| C6  | Zero-use captain tools: `deliver_file`, `work_items`/`work_item_write` (the `clankie work` CLI stays), `discord_create_thread`, `discord_join_thread`, `discord_unreact` | **Cut** | —     | 0 ever                                                                           | ~0.3k       | —                                                    | The work CLI has 205 agent calls in 30d. The tool twins have none.                                                                                                                            |
| C7  | Zero-use CLI nouns `reset` and `operator-credential`                                                                                                                     | **Cut** | —     | 0 ever                                                                           | ~0.1k       | —                                                    | `image-model`/`video-model` go with C14. `terminal`, `keys` and `deprovision` wait for D2.                                                                                                    |
| C8  | Slash wrappers never typed whose CLI noun exists: `/access`, `/awake`, `/devices`, `/doctor`, `/fleet`, `/history`, `/rooms`, `/sessions`, `/skills`                     | **Cut** | —     | 0 lifetime in the console                                                        | ~0.4k       | —                                                    | Settings with no CLI noun (`/routing`, `/compaction`) and onboarding (`/setup`, `/login`) stay under the repo's "settings in the TUI" rule, even at zero use. This install is past first run. |

### Batch 2: surfaces from the surface review (VUH-1460)

| ID  | Item                                                                                                                           | Call                                 | Crit.                     | Use                                                                 | Lines        | Covered by | Evidence                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------- | ------------------------------------------------------------------- | ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C9  | Discord Activity, the `activity` and `tunnel` services, `rendered-surface-client`, the producer credential                     | **Cut**                              | L (in theory)             | No launch since 08-19. Tunnel's last requests 08-16/17, all failed. | ~1.9k        | —          | Discord caps unverified Activities to the app team. It runs a public listener for nobody. Avatar route: D5. ADRs 0047, 0114.                          |
| C10 | User-session lab body (`apps/discord-user-session`, `observe_share`, stream-watch observation, opt-in, TUI lab flow, settings) | **Cut** (tag `lab-body-final` first) | U (screen watch, Go Live) | Never enabled; no receipts file has ever existed                    | ~7.4k        | —          | Every voice change has to be wired through a second body that is off. It also carries account-termination risk. ADRs 0024, 0048, 0098 (user-session). |
| C11 | Second-transport branches in `discord-presence-core`                                                                           | **Fold** after C10                   | —                         | —                                                                   | est. 0.5k–2k | —          | Not measured. The size depends on how much of the 11.6k-line core is transport-neutral only because of the second body.                               |

### Batch 3: bespoke connectors and helpers the ecosystems cover

| ID  | Item                                                                                              | Call                                                                       | Crit.    | Use                                                 | Lines  | Covered by                                                             | Evidence                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------- | --------------------------------------------------- | ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| C12 | Email IMAP/SMTP connector (`email.ts`, `email_*` tools, `/connect email`, settings, broker entry) | **Cut**; the owner installs a mail MCP server through `mcp-host` if wanted | —        | 6 calls ever (last 09-27). `email_read` never.      | ~0.9k  | Gmail MCP; Dots' connectors                                            | Bespoke connector. `mcp-host` already gates owner servers per lane.                                             |
| C13 | tldraw diagram driver (`tldraw-host.ts`, `draw_er_diagram`, `draw_sequence_diagram`)              | **Cut**                                                                    | —        | 1 diagram in 30d (09-07). `draw_er_diagram` 0 ever. | ~0.9k  | CC and Cx draw Mermaid and artifacts; tldraw has its own agent tooling | Drives one desktop app for one lane. ADR 0096.                                                                  |
| C14 | Video generation (`generate_video`, video providers, `video-model` CLI)                           | **Cut**; keep image generation                                             | L (weak) | 0 ever. Images: 0 since 08-15.                      | ~0.5k  | No harness makes video                                                 | Neither is used. Images stay because a picture he makes in a room is character (ADR 0085). See D3.              |
| C15 | Personal-assistant skills: `comparison-shopping`, `daily-digest`, `inbox-triage`, `trip-planning` | **Cut**                                                                    | —        | One bulk read each (09-28), no loads                | 0.1k   | Dots, ChatGPT, Claude connectors                                       | This is Dots' ground. Also stop building bespoke Google connectors (VUH-1430–1432) and use MCP servers instead. |
| C16 | Rivals client (`rivals.ts`, `rivals` tool and CLI, ADR 0175)                                      | **Cut unless** Clankie plays Rivals this month (D4)                        | L        | Tool 0 ever; 3 CLI calls (last 09-21)               | ~0.45k | —                                                                      | A game body is character. It has never played.                                                                  |

### Batch 4: thin harness control (after VUH-1458 and VUH-1459 pass live)

| ID  | Item                                                                                                                                                                                                                                                | Call                                                                         | Crit. | Use                                         | Lines | Covered by                                 | Evidence                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----- | ------------------------------------------- | ----- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| C17 | `codex queue` delivery (`codex-seat.ts`, lsof session lookup, `paneProcesses`/`openFiles`/`codexQueue` runner members)                                                                                                                              | **Cut**                                                                      | —     | Superseded for new local hires              | ~0.2k | Cx app-server (`turn/start`, `turn/steer`) | The app-server adapter landed today (VUH-1459).                                                                |
| C18 | Terminal-lane hire scraping: Codex folder-trust, Claude channel-warning detection, `<pasted_content>` brief verification, Claude and Codex branches of `distillHerdrSeatReply`, `herdr-summaries.ts`, the `terminal:` branch of `sendAndWatchReply` | **Cut**                                                                      | —     | Fallback only once the adapters are primary | ~0.6k | CC channels and Stop hooks, Cx app-server  | Keep `promptAgent` as the single typed fallback for pi seats, remote fleets and panes the owner started.       |
| C19 | `herdr_watch` for adapter seats                                                                                                                                                                                                                     | **Fold** into adapter completion. Keep `agent wait` for pi and remote seats. | U     | 175 seat + 27 captain calls                 | small | CC Stop hooks, Cx `turn/completed`         | Heavily used, so this is a behavior change rather than a deletion. The adapter already knows when a turn ends. |

Kept here: the owner's direct terminal (`herdr-terminal*.ts`, `runtime-terminals.ts`;
U, ADR 0144), the census and the fleet cursor, the seat outbox, both seat plugins,
`agent-transcript`, and the remote-fleet transport.

### Batch 5: TUI folds

| ID  | Item                                                                                                                                | Call                                    | Crit. | Use                                                                 | Lines     | Evidence                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----- | ------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| C20 | Second hosted console (`runHostedConsole` in `hosted-console.ts`, with its own `/persona`, `/model`, `/fleet`, `/connect`, `/keys`) | **Fold** into the main console          | U     | `/conversation`, `/model`, `/keys` resolve here (49/33/26 lifetime) | ~0.3k net | It re-implements the local slash commands for a hosted body.                                            |
| C21 | `memory-commands.ts` alongside `command/memory.ts`; `voice-commands.ts` alongside `command/voice.ts`                                | **Fold** each wrapper onto its CLI twin | —     | used                                                                | ~0.3k net | These are the only parallel pairs. Every other `*-commands.ts` file already wraps its `command/*` twin. |

### Batch 6: skills (with VUH-1457)

| ID  | Item                                                                                                                                                                                                      | Call                                 | Crit. | Use                                                             | Lines | Evidence                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----- | --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C22 | Nine vendored process skills with no traceable use of Clankie's copy: `blast-radius`, `co-w`, `conventions`, `docs-review`, `interrogate`, `linear-grind`, `linear-plan`, `perf-review`, `pr-description` | **Unbundle**                         | —     | 0 prefixed loads; `interrogate` and `pr-description` 0 anywhere | ~1.4k | The eval baseline: the Clankie layer adds +27k tokens per trial with the pass rate within noise. They are copies of James's global skills, so nobody loses them. |
| C23 | Merge `lead`/`swarm-lead`/`herdr-lead` (already VUH-1457) and drop `herdr-lead`'s vendored dashboard plugin (`dash.ts` 2,575, `lib.ts`, `check.ts`, `map.html`)                                           | **Cut** the dashboard with the merge | —     | `/board` typed once                                             | ~4.8k | The dashboard duplicates the app's fleet view and the Herdr plugin panes.                                                                                        |

Kept: `this-machine` (400 reads), `trace-clankie`, `swarm-mcp`, `desktop-control`,
`work-items`, `herdr`, `pokeagents`, `computer-use-delegation`, `research-team`,
`c`, `p`, `shared-checkout`, `solution-space`, `reflect`, `testing-archive`, and the
Linear skills. Anything VUH-1457's eval shows to be noise goes in that issue.

### Batch 7: package folds and housekeeping

| ID  | Item                                                                                                                                                                                                                                                                | Call                                          | Evidence                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C24 | `media-connector` into `apps/clankie/src/media-generation.ts` (single consumer); what is left of `agent-hosts` after C3 into `apps/clankie`; `rendered-surface-client` goes with C9                                                                                 | **Fold**                                      | Packages 20 → 17. Line effect is small (package boilerplate).                                      |
| C25 | Seven `music_*` verbs (5 have 0 captain calls ever)                                                                                                                                                                                                                 | **Fold** into one `music` tool with an action | Keep the DJ desk (L; 195 receipts in total). This is fewer tool schemas per turn, not fewer lines. |
| C26 | Per-package line-count report in CI (informational)                                                                                                                                                                                                                 | **Add**, first                                | Acceptance item. It gives every batch its before and after.                                        |
| C27 | Outside the repo: `~/.clankie/captain/evaluator` (2.8 GB), 160 MB of dead logs from the old architecture (`runner.log` 146 MB, `captain-eve.log`, `cloudflared.log`), the untracked `apps/gateway` build leftovers, and after C9 the named tunnel and its DNS route | **Delete**                                    | Nothing tracked reads them (`git ls-files apps/gateway` is empty).                                 |

## Keep and invest

These pass the test, and most carry real traffic. Full list in the appendix.

| Area                                                                        | Crit.                    | Use (30d)                                                        | Notes                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity, persona, `get_self_state`, episodes                               | L                        | 12 self-state, 4 remember, 6 recall                              | 18 episodes in total. **Person memory (`discord-people/`) is empty**, so the ADR's "memory across rooms" has barely started. It needs investment, not a cut.                  |
| Discord bot body, voice, Vox, the DJ desk                                   | L, U                     | 871 text ingress, 115 replies, 9 voice joins, 42 audible replies | Core character. Nobody else does Discord voice.                                                                                                                               |
| Play (PokeAgents seat, `packages/play`)                                     | L                        | 1 refused attempt (09-29). Last session 08-30.                   | Keep: ADR 0203 names play as a body. It should start lazily instead of with every boot. All 418 `play_transcript_delivery` receipts delivered nothing, which is a bug to fix. |
| Swarm (`packages/swarm`, `swarm_*`)                                         | U                        | 184 seat calls, **none after 09-27**                             | Cross-vendor; ADR 0203 keep-and-invest. The silence since 09-27 is worth asking about.                                                                                        |
| App path: relay, pairing, devices, push, gateway connector, encryption      | U                        | Relay: ~398k requests, 92% roster, persona and fleet polling     | The app is first-class. The polling share suggests the relay could use the fleet cursor (ADR 0150) rather than polling.                                                       |
| Herdr runtime, census, owner terminal, seat plugins, seat outbox            | U                        | Seat MCP: 679 calls                                              | This is the thin control ADR 0203 asks for.                                                                                                                                   |
| Linear MCP tools and the notification inbox                                 | U (one tracker identity) | 341 captain + 88 seat calls                                      | Keep. VUH-1382 is its stall.                                                                                                                                                  |
| Browser host                                                                | U for Discord lanes      | 127 calls                                                        | CC has Chrome built in, but social lanes run on pi. This row follows D1.                                                                                                      |
| Credential broker, settings, protocol, model provider and registry          | U / infrastructure       | —                                                                | Everything depends on these.                                                                                                                                                  |
| Model routing (`routing.ts`, `escalate`), `request-budget.ts`, turn metrics | U (cross-lab)            | used                                                             | pi-only plumbing. These follow D1.                                                                                                                                            |
| TUI chat shell, onboarding and secret wizards, the CLI and launcher         | U                        | 66 console opens and 36 restarts by James in 30d                 | First-class under ADR 0203. The CLI is how every agent drives him.                                                                                                            |
| Docs site, Herdr plugin                                                     | — / U                    | —                                                                | The docs site is the public guide. The Herdr plugin is 6 lines of shell.                                                                                                      |

## Decisions beyond yes or no

- **D1: the pi operator lane.** Operator conversations run Clankie's own pi loop
  with shell and file tools. The Claude Code seat (ADR 0152) and, since today, the
  Codex seat do the same job inside the lab harnesses. Moving operator work to
  seats would leave pi running only his social and voice lanes, which is where his
  character lives. Several thousand more lines would then be candidates:
  - routing and request budgeting;
  - the composer catalog;
  - conversation fork and replay;
  - the operator half of `captain.ts` and `conversations.ts`;
  - part of turn metrics.

  Blockers:
  - hosted bodies with capped model usage (VUH-1371) have no harness subscription;
  - the app's Clankie thread reads the operator conversation;
  - I could not split the 739 `bash` calls by lane, so I don't know how much
    operator work still runs on pi.

  Recommendation: answer it with VUH-1473 (the seat eval) and VUH-1474 (the lead
  eval) before cutting anything.

- **D2: the `hosted-*` modules** (nine files, 1.9k lines plus 2.8k of tests). These
  run only on managed bodies. Credits, plan quotas and heartbeat look like control
  plane, which ADR 0183 puts in `clankie-ops`. ADR 0183 also keeps the single-owner
  Linux image public. Moving them doesn't shrink the system, only this repo. Move
  them, or record why they stay?
- **D3: media.** Cut video (C14) and keep images? Or cut both, since neither has
  been used since 08-15?
- **D4: Rivals** (C16). Keep only if Clankie will actually play Rivals this month.
- **D5: Activity avatars** (from VUH-1460). When C9 lands, drop custom webhook
  avatars, or move the route to a public origin.
- **D6: Vox video.** After C10, trim the roughly 3.3k lines of Rust only watch and
  Go Live use, or leave Vox alone. The surface review recommends leaving it.

## Batches and expected reduction

Each batch is one or more commits with `pnpm check` green, knip clean, and the docs,
trace-clankie, the ADR index and `docs/architecture.md` updated in the same change.
Before counts: 157.3k source lines and 91.7k test lines (249k); 9 tracked apps; 20
packages.

| Batch     | Items                 | Depends on                          | Lines removed                                                  |
| --------- | --------------------- | ----------------------------------- | -------------------------------------------------------------- |
| 0         | C26 line-count report | —                                   | +0.1k                                                          |
| 1         | C1–C8                 | —                                   | ~5.2k                                                          |
| 2         | C9–C11                | VUH-1460 decisions, D5              | ~9.8k–11.3k (+3.3k Rust with D6)                               |
| 3         | C12–C16               | D3, D4                              | ~2.4k–2.9k                                                     |
| 4         | C17–C19               | VUH-1458 and VUH-1459 verified live | ~0.8k                                                          |
| 5         | C20–C21               | —                                   | ~0.6k                                                          |
| 6         | C22–C23               | VUH-1457                            | ~6.2k                                                          |
| 7         | C24–C25, C27          | C3, C9                              | ~0.1k                                                          |
| **Total** |                       |                                     | **~25k–27k, ~30k with D6**, before the 10–20% wiring allowance |

After: about 222k–224k lines (10–12% less), 7 apps, 17 packages, two fewer
always-on processes (the Activity server and its public tunnel) plus the
evaluator's pane, and about 25–30 fewer tool schemas offered to every operator
turn. D1 is the only lever
that could move this into the tens of thousands again.

## What I'm unsure about

- **C11's size.** I didn't measure how much of `discord-presence-core` exists only
  for the second transport. It could be small.
- **Zero use on this Mac is not zero use.** For hosted and PC use (C7, D2) I can't
  see the other machines.
- **Slash commands have no dates.** C8 rests on lifetime counts since 2026-07-10.
- **Skills.** "No traceable use of Clankie's copy" (C22) can't tell Clankie's copy
  from James's global copy when a bare name was loaded. The eval baseline is the
  stronger evidence.
- **Unused doesn't prove useless.** Goals (C2), video (C14) and Rivals (C16) never
  got a fair trial. The ADR's test is use plus coverage, and I applied it as
  written.

## Appendix: inventory

### Apps and integrations

| Item                                         | Src + test                | Crit.      | Call                               |
| -------------------------------------------- | ------------------------- | ---------- | ---------------------------------- |
| `apps/clankie`                               | 43.4k + 38.3k             | L, U       | Keep; cuts inside (C1–C8, C12–C19) |
| `apps/tui` (CLI, launcher, console)          | 25.9k + 16.1k             | U          | Keep; C8, C20, C21                 |
| `apps/discord-bridge`                        | 5.3k + 4.6k               | L          | Keep                               |
| `apps/discord-user-session`                  | 4.1k + 2.2k               | U (unused) | C10                                |
| `apps/discord-activity`                      | 1.2k + 0.4k               | L (unused) | C9                                 |
| `apps/relay`                                 | 0.9k + 1.3k               | U          | Keep                               |
| `apps/vox` (Rust, AGPL)                      | 15.3k                     | L, U       | Keep; D6                           |
| `apps/docs`                                  | 2.2k                      | —          | Keep (public guide)                |
| `apps/gateway`                               | untracked build leftovers | —          | C27                                |
| `integrations/claude-plugin`, `codex-plugin` | small                     | U          | Keep (the thin path)               |
| `integrations/herdr-plugin`, `worker-skills` | tiny                      | U          | Keep                               |

### Packages

| Package                                      | Src + test    | Consumers                    | Call                                      |
| -------------------------------------------- | ------------- | ---------------------------- | ----------------------------------------- |
| protocol                                     | 8.1k + 2.8k   | everything, app              | Keep                                      |
| discord-presence-core                        | 11.6k + 10.5k | clankie, both Discord bodies | Keep; C11                                 |
| play                                         | 4.3k + 3.3k   | clankie                      | Keep                                      |
| model-provider, model-registry               | 3.3k + 3.3k   | clankie, tui                 | Keep                                      |
| credential-broker                            | 3.1k + 2.2k   | many                         | Keep                                      |
| interactive-environment, environment-runtime | 3.1k + 1.4k   | clankie, play                | Keep                                      |
| settings                                     | 1.8k + 0.8k   | many                         | Keep                                      |
| work-items                                   | 1.4k + 0.6k   | clankie                      | Keep (the `work` CLI has 205 agent calls) |
| swarm                                        | 1.4k + 1.1k   | clankie                      | Keep                                      |
| agent-transcript                             | 1.2k          | clankie, tui                 | Keep                                      |
| vox-client                                   | 1.1k + 0.6k   | Discord bodies               | Keep (license boundary)                   |
| agent-hosts                                  | 0.8k + 0.3k   | clankie                      | C3, then C24                              |
| observability                                | 0.7k + 0.5k   | clankie, tui                 | Keep                                      |
| play-voice                                   | 0.7k + 0.6k   | clankie, Discord bodies      | Keep                                      |
| api-client                                   | 0.6k + 0.2k   | tui, bodies, app             | Keep                                      |
| media-connector                              | 0.5k + 0.3k   | clankie (one file)           | C24                                       |
| persona-images                               | 0.5k + 0.4k   | clankie, tui                 | Keep (L)                                  |
| rendered-surface-client                      | 0.2k + 0.2k   | clankie (Activity)           | C9                                        |

### Services

| Service                                                           | Crit. | State                                        | Call                          |
| ----------------------------------------------------------------- | ----- | -------------------------------------------- | ----------------------------- |
| `clankie`                                                         | L, U  | running                                      | Keep                          |
| `relay`                                                           | U     | running                                      | Keep                          |
| `discord-bridge`                                                  | L     | running                                      | Keep                          |
| `discord-user-session`                                            | U     | off, never started                           | C10                           |
| `activity`                                                        | L     | running, unused                              | C9                            |
| `tunnel`                                                          | —     | running; public listener, last traffic 08-17 | C9                            |
| `awake`                                                           | U     | off (opt-in)                                 | Keep (VUH-1461)               |
| Service-owned: Vox, agent-browser daemon, Herdr server, play host | L, U  | —                                            | Keep; play host starts lazily |

### Captain tools (lane bank, shared with the seat's MCP)

| Family                                                                                | Use (30d)                              | Call                    |
| ------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| pi `bash/read/edit/write`                                                             | 739/265/23/19                          | D1                      |
| `linear_*` (MCP), `mcp_tool_search`                                                   | 341, 33                                | Keep                    |
| `browser_*`                                                                           | 127                                    | Keep (D1)               |
| `swarm_*`                                                                             | 33 (seat 184), none after 09-27        | Keep                    |
| `herdr_watch`, `hire_agent`, `message_seat`                                           | 27/1/0 (seat 175/58/64)                | Keep; C19               |
| `observe_room`, `get_self_state`, `remember_episode`, `recall_episodes`               | 15/12/4/6                              | Keep                    |
| `voice_join`, `voice_leave`, `send_text_update`, `discord_react`                      | 7/0/9/0 (react used before the window) | Keep                    |
| `schedule_wake`, `cancel_wake`                                                        | 0 (seat 2; 2 before the window) / 0    | Keep                    |
| `pokeagent_*`                                                                         | 1                                      | Keep                    |
| `music_*`, `youtube_search`                                                           | voice-side 8 receipts                  | C25                     |
| `generate_image` / `generate_video`                                                   | 0 / 0 ever                             | Keep / C14              |
| `email_*`                                                                             | 3 (seat 3)                             | C12                     |
| `draw_er_diagram`, `draw_sequence_diagram`                                            | 0 / 1                                  | C13                     |
| goals (4 tools)                                                                       | 0 ever                                 | C2                      |
| `agent_session*` (4 tools)                                                            | 0 ever                                 | C3 (keep list and read) |
| `deliver_file`, `work_items`, `work_item_write`, `discord_*thread`, `discord_unreact` | 0 ever                                 | C6                      |
| `observe_share`, `discord_watch_start/stop`                                           | 0 in 30d                               | C10, C9                 |
| `rivals`                                                                              | 0 ever                                 | C16                     |
| `escalate`                                                                            | routed runs                            | D1                      |

### CLI nouns (agent calls in 30d, Claude + Codex; James's own in brackets)

- **Heavily used:**
  - console [66], `restart` [36], `pair` [12], `seat` [9]
  - `herdr` 289, `work` 205, `linear` 154, `status` 107, `pair` 79, `runtime` 63,
    `model` 60, `gateway` 68, `mcp` 54, `swarm` 52, `doctor` 49
- **Moderate:** `skills`, `devices`, `voice`, `conversations`, `send`, `prompt`,
  `accounts`, `persona`, `agents`, `access`, `awake`, `login`, `memory-card`,
  `health`, `discord`, `seat-sync`, `memory`, `connect`, `autostart`, `effort`,
  `connections`, `down`, `browser`, `seat-hook`, `remote-access`, `metrics`,
  `telemetry`, `fleet`, `play`. All keep.
- **Near zero:** `whoami`, `disconnect`, `sessions`, `file`, `games`, `workdir`,
  `stance`, `logout`, `conversation`. Keep: each is a thin noun over a kept API.
  `rivals` follows C16 and `evaluator` goes with C1.
- **Zero ever:**
  - `reset` and `operator-credential`: C7;
  - `image-model` and `video-model`: C14 (`image-model` stays if images stay);
  - `terminal`, `keys` and `deprovision`: D2.

### TUI slash commands (lifetime since 2026-07-10)

- **Used:** `/conversation` 49, `/model` 33, `/auth` 26, `/discord` 18, `/connect`
  18, `/effort` 16, `/provider` 14, `/new` 12, `/persona` 11, `/herdr` 9, `/reset`
  9, `/remote-access` 8, `/games` 7, `/status` 6, `/voice` 6, `/chats` 5, `/help`
  4, `/connections` 4. Keep.
- **Retired tokens still typed:** `/approvals` 13, `/mission` 4, `/doctrine` 2.
  Nothing to cut. A "that command is gone" hint would help.
- **Never typed:**
  - wrappers: C8;
  - `/goal`: C2;
  - `/rivals`: C16;
  - `/routing`, `/compaction`, `/setup`, `/login`, `/logout`, `/pair`,
    `/reconnect`, `/terminal`: keep (settings, onboarding or hosted).

### Bundled skills (35)

| Skill                                                                                                             | Evidence                                  | Call              |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------- |
| this-machine, trace-clankie, swarm-mcp, desktop-control, work-items, herdr                                        | clearly read as Clankie's copy            | Keep              |
| lead, swarm-lead, herdr-lead                                                                                      | used; the merge is already VUH-1457       | C23               |
| pokeagents, computer-use-delegation, research-team                                                                | small, product-specific                   | Keep              |
| c, p, shared-checkout, solution-space, reflect, testing-archive, linear-issues, linear-orient, herdr-handoff      | used by fleet agents; decided by VUH-1457 | Keep pending eval |
| blast-radius, co-w, conventions, docs-review, interrogate, linear-grind, linear-plan, perf-review, pr-description | no traceable use of Clankie's copy        | C22               |
| comparison-shopping, daily-digest, inbox-triage, trip-planning                                                    | one bulk read; Dots' ground               | C15               |
