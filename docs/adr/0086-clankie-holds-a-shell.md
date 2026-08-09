# ADR 0086: Clankie holds a shell

Status: accepted (James, 2026-08-09). Amends the shell/filesystem exclusion in
[ADR 0027](0027-mcp-worker-tool-projection.md) and
[ADR 0082](0082-clankie-holds-the-browser.md).

## Context

The captain could reach the web, drive a browser, start missions, and direct
workers, but could not read a file or run a command. `bash`, `read_file`,
`write_file`, `glob`, and `grep` were `disableTool()` stubs. ADR 0027 called the
tool-less captain "the architecture's core safety property," and ADR 0082
re-affirmed it while adding the browser.

The property was doing two jobs at once, and only one of them was load-bearing:

1. **He cannot change the tree he is judged against.** A seat that can write
   files can edit its own doctrine, tests, and evaluators. This is the real
   invariant.
2. **He cannot see the machine he lives on.** This was never argued for
   separately; it came along with (1) because the framework tools bundle read
   and write behind one switch.

Separating them costs nothing and buys a captain who can look at a log before
theorizing about it, check what a worker actually wrote, and keep notes between
turns. The operator asked for exactly that split: read anything, write in one
scratchpad.

Options weighed:

1. Re-enable eve's built-in sandbox tools. Rejected: eve's `/workspace` is an
   isolated Docker or microsandbox VM, so "read anything" would mean anything
   inside a container that cannot see the host. It answers the scratchpad half
   and none of the read half.
2. Author filesystem tools in the captain process using `node:fs` directly.
   Rejected: the scratchpad boundary would be a line of code inside the thing
   being bounded, and no decision would be recorded. It reverses invariant (1)
   rather than preserving it.
3. Register an off-the-shelf filesystem MCP server. Rejected: those servers
   scope read and write to the same allowed-directory list, so "read the host,
   write one directory" is not expressible.
4. A runner-hosted shell reached through the control plane, confined by the
   existing `ShellSandbox`. Accepted.

## Decision

**The runner executes; the captain asks.** `createCaptainShellHost`
(`apps/runner/src/captain-shell-host.ts`) owns both verbs behind the runner's
shared authenticated loopback plane
([ADR 0087](0087-one-loopback-plane.md)). The control plane mediates at `/v1/shell/run` and
`/v1/shell/read` and decides nothing, matching the division the browser and
media routes already use.

**Two actions, deliberately asymmetric.** `shell.captain.run` is
`reversible-write`; `shell.captain.read` is `read`. Neither is named in the
shipped profiles, so both resolve through their risk class — an operator who
wants the shell shut while leaving reads open adds `shell.captain.run` to
`actions` without touching code. Every call appends a `captain.shell.decided`
event whether or not it ran.

**Writes reach one directory; reads reach the host.** `run` executes
`/bin/bash -c` under the existing `ShellSandbox`, whose Seatbelt profile confines
`file-write*` to the workspace and SIGKILLs anything else. The workspace is the
scratchpad (`$CLANKIE_RUNNER_STATE/scratch`, overridable with
`CLANKIE_CAPTAIN_SCRATCH`), and `HOME` and `TMPDIR` point at it so tools that
write beside themselves stay inside. Reads are the sandbox's ambient default:
the whole filesystem. A blocked write comes back as an `ok` result carrying a
`denials` entry rather than a silent success, because a refusal he cannot see is
one he will report as having worked.

**No network from the shell.** The sandbox denies egress and no allowlist proxy
is started. A seat that can both read the disk and reach the internet is an
exfiltration tool regardless of how its description is worded; fetching stays
the browser's job, where doctrine already classes it.

**No inherited environment.** The command gets `PATH`, `LANG`, `HOME`, and
`TMPDIR` and nothing else. The runner's own `CLANKIE_RUNNER_TOKEN` and provider
credentials never enter it.

## Where the boundary actually holds

Probed on macOS 27 against this profile, and the load-bearing cases are pinned
in `apps/runner/test/captain-shell-host.test.ts`:

| Attempt                                     | Result                                  |
| ------------------------------------------- | --------------------------------------- |
| Write outside the scratchpad                | `Killed: 9` (SIGKILL), file unchanged    |
| Write a script, `chmod +x`, run it           | Runs, and is confined the same way      |
| Detach a child with `nohup` and write out    | Child killed; confinement is inherited  |
| `curl` any host                              | `Killed: 9`                             |
| `open -a Calculator`                         | "Unable to find application" — no launch |
| `launchctl list`                             | Empty; launchd is unreachable           |
| `ls ~/.ssh`, `ls ~/.claude`                  | Succeeds — reads are unrestricted       |

Seatbelt is inherited across `fork`/`exec`, so writing a script and running it
is not an escape: the script is the same shell. The routes to an *already
running* unsandboxed process are closed by `(deny default)`, which withholds
`mach-lookup` and so takes LaunchServices and launchd with it.

Not verified: whether AppleScript can drive another application through
`appleeventsd`. `osascript` itself runs (in-sandbox), and the obvious mach paths
are denied, but the Apple Events route was not conclusively probed. Treat it as
open until someone tests it.

The real path to execution outside this sandbox is not a bypass at all — it is
`create_mission` and `direct_agent`. Governed workers own worktrees and can
write the repository by design. This ADR confines his *shell*; what confines his
*delegation* is doctrine, and that is a separate boundary with separate gates.

## Consequences

- Reads are unrestricted by design, and that includes credentials on disk —
  `~/.claude`, `~/.ssh`, provider config. The worker sandboxes deny those paths
  explicitly; this one does not, because the operator asked for an unrestricted
  read boundary. Narrowing it later is a positive read-root set passed to
  `ShellSandbox.prepare`, which the sandbox already supports.
- Prompt injection reaching a page in his browser now has a shell one hop away.
  The shell's lack of egress is what keeps that from being an exfiltration path;
  it should not be given network access without revisiting this.
- The captain can now write files, so invariant (1) rests on the scratchpad
  boundary rather than on the absence of the capability. `apps/runner`, not the
  captain, is where that boundary is enforced and where a regression would land.
- `bash` and `read_file` join `CAPTAIN_AUTHORED_TOOL_NAMES`; `write_file`,
  `glob`, and `grep` stay `disableTool()`, since `bash` covers all three and
  three more tools would be three more surfaces to reason about.
- macOS only. `ShellSandbox` has no enforced profile on other platforms and
  fails closed, so the shell reports `sandbox_unavailable` rather than running
  unconfined.
