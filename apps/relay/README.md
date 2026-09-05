# Remote relay

The launcher supervises the relay like every other member of the stack:
`clankie restart relay` owns it, `clankie status` reports it, and it restarts
with the clankie service whose brokered captain bearer it holds. Pairing goes
further and guarantees it: `clankie pair` and `/pair` reuse a healthy relay,
start a stopped one, and mint no offer at all if it will not come up, so a
paired device never points at a relay nobody started. A control plane that is
not this machine runs its own relay; pairing says so instead of starting a
local one that proves nothing. The headless command contract is
[`docs/cli.md`](../../docs/cli.md).

It listens on `CLANKIE_RELAY_PORT` (default 4321 — 4320 belongs to the
activity surface). The origin remote devices should reach it on is
owner-authored settings (`relay.url` in `~/.config/clankie/settings.json`, or
the `CLANKIE_RELAY_URL` override): when set, the control plane advertises it
in pairing and session-refresh responses, so paired devices follow a moved
relay without a rebuild.

The relay is the HTTP-only operator-conversation boundary for remote Apple
clients. Tailscale may carry the connection, but network identity is not
authorization: every request carries a device-session bearer.

## Operator conversation boundary

The HTTP surface composes the strict `@clankie/protocol` operator service contract:

- `POST /operator/v1/dispatch` accepts the strict operator service contract,
  including the cursor-long-polled `fleet` snapshot and persona, roster,
  channel, terminal, and conversation operations. Seat-scoped creates and sends
  use the same authenticated boundary.
- `POST /operator/v1/tail` accepts the same strict `tail` request and emits newline-delimited `{ kind: "event", event }`, `{ kind: "recovery", recovery }`, or terminal `{ kind: "auth_failure", failure }` frames.
- `POST /operator/v1/terminal-tail` accepts a strict `terminal_tail` request and emits bounded native-consumable ANSI `frame`, `reset`, `unavailable`, or `auth_failure` items.

The relay checks the current device record and `chat` grant against the clankie
service on every request, between tail polls, and immediately before emitting a
tail page. Expiry, revocation, and grant removal therefore take effect without a
reconnect. It uses its own captain service credential for the upstream hop;
device credentials never cross it.

Terminal tails apply the same checks with the distinct `terminalObserve` grant.
They address Herdr panes by stable terminal id and end with a typed reset when a
native surface must reconnect for a fresh full redraw.

Terminal input rides the plain dispatch path under the distinct
`terminalControl` grant: `terminal_control` manages one exclusive renewable
input lease per terminal and `terminal_input` writes bounded raw VT bytes under
it. The relay only maps the ops to the grant; lease arbitration lives with the
captain.

Responses pass the strict public schema and value redaction before emission.
Captain session IDs, continuation tokens, provider credentials, and arbitrary
provider payloads do not cross the boundary.

Turn submission retains the registry's `expectedRevision` fence. Duplicate delivery of the same authenticated device request is collapsed to one in-flight or retained result; a stale fence returns the registry's typed `revision_conflict` result. Replay and tail cursors remain opaque and surface-scoped. A dropped stream resumes from the last emitted event cursor, while expired or reset cursors produce one typed recovery frame and close.
Transient `seat_offline` refusals collapse concurrently but are not retained, so a retry observes a pane that has returned.

![Relay device-request architecture](../../docs/diagrams/relay-architecture.jpg)

[Editable Turbopuffer tldraw source](../../docs/diagrams/clankie-docs-diagrams-2.tldraw)

## Run

```bash
pnpm --filter @clankie/relay start
```

Configuration:

- `CLANKIE_CONTROL_PLANE_URL` defaults to `http://127.0.0.1:4310` (device verification; the env name is a compatibility alias for the clankie service URL).
- `CLANKIE_CAPTAIN_URL` defaults to `http://127.0.0.1:4310` (conversation dispatch on the same service).
- `CLANKIE_CAPTAIN_TOKEN` enables the authenticated captain hop; conversation requests fail closed when absent, and the relay refuses to start with a token under 16 characters.
- `CLANKIE_RELAY_HOST` defaults to loopback; set it to a specific tailnet interface for direct physical-device access.
- `CLANKIE_RELAY_PORT` defaults to `4321`; `PORT` is its deployment-platform fallback.

Structured logs contain bounded, redacted route, operation, device,
conversation, surface, status, and recovery metadata only. They never include
message text or either bearer credential.
