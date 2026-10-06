# PC Claude tool-check recovery (VUH-1745)

The patch prevents an ordinary remote observation timeout from immediately
destroying every pane's authenticated relay. Claude retries at idle through
fresh link discovery, logs each warning cause once across intermittent
recovery, and names timeout, connection refusal, lost transport, HTTP refusal,
or missing native pane proof with a fixing action.

## Incident evidence and limits

The reported failure window was 2026-10-06 15:14–15:20 UTC. The runtime stayed
at `c72c3d02`; reconnecting the plugin and restarting Claude did not reliably
resolve it. [Selected service events](link-window.json) show repeated PC relay
disconnects and SSH session-open refusal from 15:15 through 15:19, then a ready
link at 15:19:43.117 UTC. This agrees with the reported spontaneous recovery.
The original logs lack request-level timeout diagnostics, so the initiating
caller and the relative contribution of SSH capacity or observer congestion
remain unproven. No stale-binding or permanent authentication fault is proven.
Tess reported no PC acceptance or hire traffic during that window.

The source had two contributing failure paths: a single queued observation
deadline closed the shared relay, and the report helper discarded the actual
exception. Its 5-second HTTP budget was also shorter than the remote native
proof's observation budget. A real isolated Windows relay reproduces the first
path; this is evidence of the mechanism, not proof of the historical caller.

## Reproduction and checks

[Windows before/after results](windows-relay.json) come from dedicated owned SSH
connections, a real Windows PowerShell/C# relay, and owned loopback listeners.
The observation sleeps 1500 ms against a 250 ms deadline. At baseline
`a00d7d8e`, the relay dies and the next observation is refused. With the patch,
the caller still times out, the late original reply is discarded, the next
observation returns `fresh-proof`, and a new TCP stream succeeds with its exact
host-observed tuple. The stream is opened **after** recovery; this run does not
prove survival of an already-open native Claude connection. Existing-stream
survival is covered by the relay boundary test. All isolated resources were
closed; no fleet discovery was published or existing pane modified.

Real `pnpm install --frozen-lockfile` completed in the owned worktree. Every
install, typecheck, lint and test ran through the legacy heavy wrapper outside
`clankie heavy --`.

- Five focused files passed **131 tests**: Claude mod/helper integration,
  remote relay, remote project proof, tool-catalog health, and fleet link.
- Package typecheck and changed-source lint passed.
- The final helper error-body reset amendment passed its focused gate:
  **12 helper integration tests**, package typecheck and lint. Combined with
  the unchanged 120 other tests above, **132 tests** cover the final source.
  [Check record](checks.txt) retains the commands and result summaries.
- No full suite, eval, release, production refresh, or service restart ran.

The helper tests run the shipped helper against real HTTP listeners. They
exercise refused ports, reset sockets, stalled response bodies, typed remote
503 reasons, binding refusal, fresh discovery, warning dedupe and automatic
idle recovery. Their native mod engine and native identity are explicit
surrogates. The HTTP/proof tests check both proof stages fail closed without
recording health, while wrong-pane and absent proof remain 403.

## Security and recovery behavior

An independent native security reviewer approved the exact source snapshot;
the review and hashes are in [security-review.md](security-review.md). The
review required a bounded lifetime for expired observations. Each original ID
keeps its slot for at most 30 further seconds, cannot resolve as fresh proof,
and is never replayed. Unknown or duplicated replies still invalidate the
relay. A genuinely stalled observer closes with a diagnostic and existing
cleanup. Native process ancestry, exact TCP tuple, live stream, session and
pane authority checks remain required.

Pane warnings expose fixed reason codes and HTTP status, never raw exception
text, commands, paths, credentials or arbitrary server bodies. Persistent
binding failures say `/mcp` → reconnect `clankie-worker`, then save and
restart/resume Claude. Transport failures point to the PC fleet link/SSH
diagnosis from Clankie's machine. Idle retry uses backoff and rereads discovery;
healthy results clear the status without resetting warning history.

## Open delivery evidence

An owned PC Claude pane must still be hired through `hire_agent` with
`fleet: "pc"`, `harness: "claude"`, tested and closed by its owner. The worker
tool catalog exposes no `hire_agent`; the request was sent to the lead but no
hire receipt was received. Read-only inspection found the default PC Claude
profile logged out: the James action there is `claude auth login`. Another
existing profile reported logged in; no profile was selected or credential
changed by this work. Native Claude pane acceptance is not claimed.

Pell owns integration and deployment. VUH-1742 owns refresh of legacy imported
PC bindings/mods. Updating files alone does not replace a mod already imported
by an existing Claude process. No existing pane was typed into, restarted or
closed. The lead should keep the issue open until the owned pane and deployed
refresh evidence are attached.
