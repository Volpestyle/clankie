# Codex app-server seats — VUH-1459

The Codex adapter starts one app-server on a private Unix socket per hire. A
native Codex TUI connects with `--remote` and creates the session. The controller
discovers it through `thread/loaded/list` and `thread/read`, then subscribes with
`thread/resume` once the first turn persists its rollout. Creating an empty thread
on the server and trying to resume it in the TUI fails with "no rollout found";
the native-first startup avoids that failure. Existing sessions use
`--remote … resume THREAD_ID` and subscribe before delivery.
Briefs and messages use `turn/start` or `turn/steer`; completion comes from
`turn/completed`, including failed and interrupted outcomes. Herdr is the view
and reports the thread identity through its recognized `herdr:codex` source.

## Protocol research

Checked the installed `codex-cli 0.159.1` help and generated TypeScript schemas
against [OpenAI's app-server documentation](https://developers.openai.com/codex/app-server).
The Unix transport uses WebSocket HTTP Upgrade, initialization precedes thread
creation, and active-turn steering requires the current turn ID. An uncertain
response must not trigger terminal replay. The adapter preserves the installed
harness's permissions and leaves approval requests to the native TUI.

VUH-1398 applies: the shared daemon does not carry each pane's hook identity.
The adapter owns a separate server and explicitly reports its thread to Herdr.
New skill homes leave `app-server-control` local: Codex rejects that directory
when it is a symlink into the owner's home.

## Real adapter run

[adapter-live.json](adapter-live.json) records a real scratch-directory run on
James's existing Codex subscription with `gpt-6-astra`. No model stub or metered
API key was used. It contains:

- The protocol-confirmed hire and follow-up completions.
- Herdr's non-null session ID, identical to the adapter's thread ID.
- Native TUI output showing the same conversation.
- A third turn submitted through the native TUI to demonstrate owner takeover;
  its completion was also observed by the protocol client.
- Cleanup of the one pane created by the run. The adapter closed its owned
  app-server before closing that pane.

The earlier exploratory probes were also closed. No other agent's pane was
changed. No service was restarted and no commits were pushed.

[pane-close-live.json](pane-close-live.json) proves manual pane closure also
stops the associated app-server: the controller became offline, left the live
registry, and removed its private socket. This check deliberately closed the
pane before calling the adapter's cleanup method.

## Full captain and resume checks

[captain-live.json](captain-live.json) runs the real scratch captain tool bank:
`hire_agent` reports `control.mode: "adapter"`, `message_seat` delivers a second
prompt, both native transcript replies are present, and `close_seat` succeeds.
The native process record shows interactive Codex attached to the private server.
Reproduce with `apps/clankie/scripts/verify-codex-seat.ts` inside Herdr; the script
creates and closes only its own seat, without restarting the service.

[resume-live.json](resume-live.json) reopens the probe's own persisted thread with
a config override, sends another protocol turn, observes its completion, and
closes the new pane. This exercises the driver seam reused by VUH-1468.

## Limits

Codex's app-server and remote TUI transports are experimental upstream. This
run proves local macOS operation with 0.159.1; it does not establish remote fleet
support or another Codex release. Existing unmanaged seats retain the queue/PTY
fallback. The adapter's live-control registry is in memory; service-restart
reattachment is not claimed by this run. Native transcripts remain durable in
the owner's Codex session store.
