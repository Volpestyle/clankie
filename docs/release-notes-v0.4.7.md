# Clankie v0.4.7

A new install on a clean Mac now finishes without an error. Clankie can also
move his whole self from one body to another, hire workers on
machines that joined him, and keep a self-hosted Mac running more reliably.

## Changes you might notice

- **Trust your Mac app once after upgrading.** The same-Mac app handoff
  ("Clankie on this Mac") no longer trusts any local app bundle, so another app
  on your account cannot take that session. Trust the app you use:

  ```sh
  clankie companion trust /Applications/Clankie.app
  ```

  The trusted list starts empty, so the handoff is refused until you do.
  [VUH-2604](https://linear.app/vuhlp/issue/VUH-2604)

- **Spider-Man (Rivals) moved out of Clankie.** It now lives in the Rivals
  Agent repository as an external game extension. `clankie rivals`, `/rivals`
  and the `gameplay.rivalsUrl` setting are gone. Any game can now be added from
  outside with `clankie games extensions add MODULE`.
  [VUH-2419](https://linear.app/vuhlp/issue/VUH-2419)
- **The hidden `clankie seat` alias is gone.** Start a seat by its harness name:
  `clankie claude`, `clankie codex`, `clankie opencode` or `clankie grok`.

## Installing and first run

- **A fresh install no longer ends in an error.** On a Mac that had never run
  Clankie, the installer installed everything, then failed while refreshing
  harness links that could not exist yet. It now finishes, and says harness
  linking waits until after you first run `clankie`.
  [VUH-2619](https://linear.app/vuhlp/issue/VUH-2619)

## One Clankie, wherever he lives

- **Move Clankie between bodies.** `clankie transfer` moves his identity,
  memory, conversations, projects and tracker to another body, and back again.
  Only one body is Clankie at a time; the one he left waits quietly and says
  where he went. Credentials, sign-ins, paired devices and machine joins stay
  where they are. This release works between bodies you run. Its
  `clankie transfer --to hosted` side (through your signed-in hosted device, so
  no token leaves your Mac) needs a hosted account and the hosted service
  update that carries it; until then, hosted transfer is not available.
  [VUH-2577](https://linear.app/vuhlp/issue/VUH-2577),
  [VUH-2582](https://linear.app/vuhlp/issue/VUH-2582),
  [VUH-2583](https://linear.app/vuhlp/issue/VUH-2583)
- **Workers on joined machines.** Clankie can hire a Claude or Codex worker on
  a machine that joined him, in folders approved when it joined, using that
  machine's own sign-in. The worker reports back to the chat that hired it.
  [VUH-2607](https://linear.app/vuhlp/issue/VUH-2607),
  [VUH-2609](https://linear.app/vuhlp/issue/VUH-2609)

## A steadier self-hosted Mac

- **Stays awake while plugged in.** A Mac running its own Clankie now stays
  reachable by default on power; on battery it still sleeps. A saved choice
  (`clankie awake on|off`) always wins.
  [VUH-2393](https://linear.app/vuhlp/issue/VUH-2393)
- **Survives upgrades and hangs.** Logs stay bounded, a hung service recovers,
  and autostart and worker panes keep working after Homebrew upgrades Node.
  [VUH-2393](https://linear.app/vuhlp/issue/VUH-2393)
- **Recovers from stalled conversation compaction** instead of holding later
  turns. [VUH-2463](https://linear.app/vuhlp/issue/VUH-2463)
- **Lighter on the CPU.** The fleet is observed from Herdr events, unchanged
  records are cached, and hired workers start only the tools they need.
  [VUH-2551](https://linear.app/vuhlp/issue/VUH-2551),
  [VUH-2391](https://linear.app/vuhlp/issue/VUH-2391),
  [VUH-2390](https://linear.app/vuhlp/issue/VUH-2390),
  [VUH-2388](https://linear.app/vuhlp/issue/VUH-2388)

## Workers you can count on

- **Claude hires no longer go missing.** A Claude worker gets its brief once
  through its own startup, and a slow or failed start is reported to the chat
  that hired it rather than silently lost.
  [VUH-2499](https://linear.app/vuhlp/issue/VUH-2499),
  [VUH-2517](https://linear.app/vuhlp/issue/VUH-2517)
- **More harnesses.** Installed Pi, OpenCode and Grok releases are admitted by
  testing the real installed version, not by matching one exact build.
  [VUH-2417](https://linear.app/vuhlp/issue/VUH-2417)
- **A standing reviewer for landings.** A project can name a reviewer seat
  that approves each worker's exact patch before it lands, with no lead relay.
  [VUH-2616](https://linear.app/vuhlp/issue/VUH-2616)
- **Tidier fleet.** Finished workers close and landed worktrees are pruned
  automatically (`autoTidy`, one hour by default). Owner-started panes are
  never closed. [VUH-2392](https://linear.app/vuhlp/issue/VUH-2392)

## Work and Discord

- **Choose your tracker** for all projects or one project, with a confirmation
  before items are left behind.
  [VUH-2532](https://linear.app/vuhlp/issue/VUH-2532)
- **Per-server Discord setup.** Roles, owners and what Clankie shows are set
  per Discord server, and Clankie can post to an owner-chosen channel he has not
  talked in yet. [VUH-2554](https://linear.app/vuhlp/issue/VUH-2554),
  [VUH-2581](https://linear.app/vuhlp/issue/VUH-2581)

## Known issues

Found in this release's fresh-install pass and not yet fixed:

- With a local model, the default 32k context is mostly used by the first turn.
  Enter a larger context window during `/setup`.
  [VUH-2623](https://linear.app/vuhlp/issue/VUH-2623)
- `/setup` suggests Clankie's install directory as the first agent's folder.
  Type the folder you want instead.
  [VUH-2624](https://linear.app/vuhlp/issue/VUH-2624)
- With no worker harness installed, the first hire fails with an unclear
  message. Install Claude Code or Codex first.
  [VUH-2625](https://linear.app/vuhlp/issue/VUH-2625)

This release provides Apple silicon macOS, Linux arm64 and Linux x64 service
archives. The companion app and hosted service have separate releases; hosted
features depend on the hosted service and your account. Hosted bodies install
official releases automatically while idle.
