# ADR 0082: Clankie holds the browser

Status: accepted (James, 2026-08-08). This amended an earlier, unretained
decision that kept web reach out of the captain. Its relevant rationale is
summarized here instead of citing a nonexistent ADR file. References to a
doctrine-governed worker projection describe the retired architecture.
The browser provider and native JavaScript boundary are updated by
[ADR 0206](0206-browser-use-pi-supplies-the-browser-workspace.md); agent-browser
implementation details below describe the earlier host.

## Context

The earlier architecture delegated web research to coding workers because it
treated all execution as one risk. That grouped unlike capabilities together:
shell and file writes can alter the repository and its safeguards, while reading
a web page cannot. Conversational browsing through a delegated worker also had
the wrong latency and could not answer directly in the room.

Clankie now leads coding agents through Herdr rather than a worker protocol, but
the same distinction remains: his browser is a first-class conversational tool,
not a coding-agent task.

## Decision

The Clankie service owns one persistent `agent-browser` MCP process and projects
its complete paginated catalog into the captain's tool bank. A small everyday
set starts active; tool search activates uncommon browser actions additively.
If the process is unavailable, the captain receives one truthful unavailable
result rather than a partial catalog.

Browser access does not grant system tools.
[ADR 0095](0095-discord-system-actors.md) separately limits shell and filesystem
access by authenticated actor and lane.

Browser calls are serialized because every room shares one browser state. The
profile persists under the service's private state root and is Clankie's, never
the operator's browser profile.

The subprocess receives an allowlisted environment, dedicated home/temp/socket
paths, and no unrelated Clankie credentials. This hardens the process but does
not sandbox it: strong containment requires moving the browser process tree into
a VM or remote broker with no host mounts or credentials.

## Amendment: headless bursts (2026-09-29, VUH-1448)

The MCP transport is persistent; browser windows and tabs are not. On host
startup, the service closes its private `clankie` daemon before connecting MCP,
waiting for its PID file to disappear before admitting a new launch and
retiring stale launch state (including a daemon started with
`AGENT_BROWSER_HEADED=1`). If that cleanup fails, browsing is unavailable.
A service-owned empty config excludes working-directory launch defaults. The
environment explicitly defaults to headless, and host-owned `--headed false`
arguments enforce it on calls. Caller-supplied raw CLI arguments remain refused.

An explicit `agent_browser_open` call with `headed: true` selects the visible
mode for that burst, including subsequent calls and recordings. `headed: false`
can return early. This preserves the [takeover seam](0127-his-accounts-are-his.md).
A mode switch saves the previous recording before relaunching.

After 60 seconds without a browser call, the host saves any recording, then
closes the private browser/daemon and resets the next burst to headless. Cleanup
is serialized with calls and also runs at host shutdown; it runs with recording
off too. A failed close is logged and retried. The daemon has an explicit
five-minute idle backstop if the host disappears. Its default headed exemption
does not bypass the host's cleanup. Human mouse/keyboard input does not extend
the host's 60-second timer; another browser call does.

Closing keeps the profile directory and persistent cookies/local storage; it
discards open tabs and unsaved page state. Native `AGENT_BROWSER_RESTORE=clankie`
and `AGENT_BROWSER_RESTORE_SAVE=always` keep a service-private storage snapshot.
In agent-browser 0.33.2, recording creates a temporary context that copies cookies
but omits local storage. Before `record start`, the host saves native storage
state and loads it into the recording context; save-on-close retains changes
made there. These auth snapshots live under the private browser home and must
be treated like the profile, never uploaded as recording evidence. Recordings remain WebM files under
`<stateRoot>/browser/recordings/`, newest 50 retained. Tool calls still use the
existing MCP-to-pi projection and remain in conversation trees.

Activation requires a coordinated service update. Startup retires the stale
daemon automatically; if manually retiring it first, target only Clankie's
private socket/session and preserve the profile. Never close the operator's
browser or another agent's session.

## Alternatives considered

- **Delegate one research agent per lookup** was rejected for conversational
  latency and indirect answers.
- **Register only a search service** was rejected because authenticated,
  JavaScript-heavy, and multi-step pages require a browser.
- **Let the captain spawn a browser itself** was rejected because process and
  credential ownership belong to the service host.
- **Expose only read-style browser actions** was rejected because a browser that
  cannot fill forms or navigate authenticated workflows does not cover the
  intended general-purpose seat.

## Consequences

- Every captain lane can browse through one shared, persistent profile.
- Untrusted room text can influence a full-action authenticated browser; content
  labels are not a security boundary, so authenticated profiles carry material
  risk until the process is isolated at the OS boundary.
- Deferred activation keeps the initial prompt small without reducing the
  registered catalog.
- Browser output remains bounded before entering model context.
- Current browser composition and tool inventory belong in the
  [architecture guide](../architecture.md).
