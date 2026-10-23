# Clankie v0.4.11

This carries v0.4.10's changes plus clearer account guidance and the release
load gate fix. v0.4.10 was never published: its CI health-latency gate failed.

Clankie is easier to set up, worker chats stay readable when a machine goes
offline, and sends across a restart are less likely to reach a worker twice.
This release also adds Stop for a working Claude seat, a Discord forum view of
built-in work, and the service side of device voice calls.

## Installing and first run

- **Clearer account guidance.** When `clankie connect hosted` finds no
  hosted Clankie on your account, it points to `clankie login` to sign this
  Mac in for remote access to your own Clankie. The setup guides now lead
  with your Mac and free accounts, with connection and support guidance
  retained for existing hosted accounts.
  [VUH-2711](https://linear.app/vuhlp/issue/VUH-2711)
- **Start in your own folder.** A new console conversation and the first
  agent's setup now use the folder where you launched `clankie`, rather than
  the installed release directory.
  [VUH-2624](https://linear.app/vuhlp/issue/VUH-2624)
- **Know what the first hire needs.** When no worker harness is ready, setup
  names the missing installation, sign-in or plugin step. A release can check
  local accounts even when Node is not on your PATH.
  [VUH-2625](https://linear.app/vuhlp/issue/VUH-2625)
- **Smoother setup and restarts.** Embedding-only Ollama models no longer
  appear as chat models. Setting up a local endpoint restarts the service for
  you, and an unset Discord bot shows as “not set up.” Conversations reconnect
  through a service restart.
  [VUH-2626](https://linear.app/vuhlp/issue/VUH-2626),
  [VUH-2663](https://linear.app/vuhlp/issue/VUH-2663)
- **An optional harness refresh cannot fail a completed install.** A locked
  Keychain or another refresh error leaves a retry hint, while preserving the
  original error for diagnosis.
  [VUH-2661](https://linear.app/vuhlp/issue/VUH-2661)

## Workers you can count on

- **Clearer console status.** Agent rows show names and recorded issue keys,
  explain actionable problems, and keep version notes out of the count of
  workers needing attention. Native lead turns animate the working indicator.
  [VUH-2694](https://linear.app/vuhlp/issue/VUH-2694)
- **Worker names stay theirs.** Hired and re-adopted workers keep proper names
  instead of a brief or pane title; names you choose are preserved.
  [VUH-2667](https://linear.app/vuhlp/issue/VUH-2667),
  [VUH-2694](https://linear.app/vuhlp/issue/VUH-2694)
- **Read linked workers' actual chats.** The console follows native messages
  and tools from linked machines, including Claude account profiles. An opened
  chat keeps its last known history when that machine goes offline, with an
  offline notice. Room replies remain visible too.
  [VUH-2695](https://linear.app/vuhlp/issue/VUH-2695)
- **Stop a working Claude seat.** The owner can interrupt an eligible Claude
  turn from a connected device. Stop checks the exact running session and
  refuses if the terminal has a typed draft. A confirmed stop releases queued
  messages; a recorded interruption appears as stopped on every device running a
  compatible app update.
  [VUH-2680](https://linear.app/vuhlp/issue/VUH-2680)
- **Review the checkout that holds the work.** Review submissions name their
  worktree explicitly, and seats missing the review tool can use
  `clankie review submit --checkout DIR --summary TEXT` from their own pane.
  [VUH-2662](https://linear.app/vuhlp/issue/VUH-2662)

## One Clankie, wherever you reach him

- **Safer sends across a restart.** Devices can ask whether the relay received
  a send. When a worker may already have taken it, an uncertain answer stays
  uncertain instead of allowing a retry to deliver the instruction again.
  Compatible device updates use these receipts to distinguish a safe retry.
  [VUH-2668](https://linear.app/vuhlp/issue/VUH-2668),
  [VUH-2670](https://linear.app/vuhlp/issue/VUH-2670)
- **The service can take a device voice call.** A compatible paired app can
  speak with Clankie through the same voice session as his Discord rooms.
  Work he accepts goes to the main conversation. His voice stays in one call
  or room at a time, and disconnected calls release it automatically. Anything that needs your approval waits in the
  main conversation, and a spoken request is not treated as approval for an
  irreversible or off-machine action.
  [VUH-2682](https://linear.app/vuhlp/issue/VUH-2682)

## Work and Discord

- **A forum can show built-in work.** Bind a Discord bot forum to a built-in
  project with `clankie discord forum bind`. Posts, tags and replies mirror
  items, status and comments; owner changes can update the tracker, while
  member input keeps its existing trust limits. The view catches up after
  downtime. Binding
  requires confirmation that everyone who can read the forum may see the
  project.
  [VUH-2531](https://linear.app/vuhlp/issue/VUH-2531)
- **Tracker media reaches your devices.** Images, videos and files linked in
  returned work items, updates and comments can be served as evidence without
  giving a device your Linear credentials. A compatible app update displays
  that media.
  [VUH-2666](https://linear.app/vuhlp/issue/VUH-2666)

## A steadier release check

- **Warm the work before measuring it.** The release load gate now warms
  real worker calls and endpoint traffic before its full measurement. A
  complete health- or CPU-only budget failure gets one fresh attempt, with
  the first failure retained for review. Budgets are unchanged; persistent
  failures, incomplete work and permission failures still block publication.
  [VUH-2713](https://linear.app/vuhlp/issue/VUH-2713)

## Known limits

- Device calls currently need a direct relay connection and a compatible app.
  Hosted and remote calls still need the gateway work in
  [VUH-2683](https://linear.app/vuhlp/issue/VUH-2683).
- The Discord forum view supports the bot body. The user-session body and
  hosted bot support remain open; without View Audit Log, forum tags are
  display-only.

This release provides Apple silicon macOS, Linux arm64 and Linux x64 service
archives. The companion app and hosted service have separate releases; hosted
features depend on the hosted service and your account. Hosted bodies install
official releases automatically while idle.
