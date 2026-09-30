# Claude worker seat: live hire, message and completion (VUH-1458)

2026-09-30, Claude Code 2.1.285, herdr 0.9.1, this Mac. Code at `8be22bee`
(adapter, plugin hooks, `clankie seat-hook`) and `7431b8c8` (hire wiring).

## What ran

[`live-hire.mts`](live-hire.mts) hires a real interactive Claude Code seat
through `HerdrWatchStore.spawnSeat` with the Claude worker adapter and this
Mac's real consent state, in a gitignored scratch directory inside the trusted
checkout. Claude's folder-trust prompt blocks a fresh `/tmp` directory, and
that decision was left alone. It then messages the seat, arms a completion
watch, reads the native transcript, and closes the pane. The service was not
restarted; hook posts went to a local capture server in the script.

The harness changed two things on purpose, logged as `START_ARGS`:

- It **dropped the fallback's `--dangerously-load-development-channels
server:clankie-seat`**, so no script accepted the owner's development-channel
  warning.
- It **loaded the worker plugin inline** (`--plugin-dir`, hooks only, no
  channel) to prove the Stop hook chain in the real TUI.

## Result ([`live-hire.log`](live-hire.log))

- **Hire:** `spawned`, with `control: { mode: "terminal", reason:
"consent_required", detail: "clankie-worker@clankie is not installed.", fix }`.
  The adapter blocked before launching anything, and the hire took the terminal
  lane in the same pane, as designed.
- **Brief:** pasted and verified in the native transcript; Claude answered
  `brief-done`.
- **Message:** `sendToSeat` delivered; Claude answered `follow-up-done`.
- **Completion:** the watch armed on the running turn and woke when it settled.
- **Hooks:** the plugin's real `SessionStart`, `UserPromptSubmit` and `Stop`
  hooks reached `clankie seat-hook`, which posted
  `/v1/fleet/seats/<pane>/hook` with the right session and Claude's own final
  text (`lastMessage: "brief-done"`, then `"follow-up-done"`).
- **Cleanup:** pane closed (`CLOSE true`), scratch directory removed.

An earlier run with a brief that wrote a file blocked on Claude's own
permission prompt. The seat read `blocked`, and the follow-up was refused
rather than typed into the prompt.

## Not yet verified live

Channel delivery (brief and messages as `clankie-worker` channel events, with
the adapter holding the seat and settling watches from Stop hooks) needs James's
one-time consent: install the plugin (disabled) and approve it in managed
settings, both named in the hire's `fix`. Unit tests cover that path
(`apps/clankie/test/claude-worker-seat.test.ts`, `seat-adapter-hire.test.ts`).
After approval, rerun the script without the harness's `startAgent` override and
expect `control.mode: "adapter"`.
