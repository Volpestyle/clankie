# Native Claude containment and original launch lifetime

This checkpoint implements the controller path and deterministic boundary tests.
No image build, container, native launcher, Claude CLI, account, provider request,
model turn or evaluation ran. The manual arm remains unsupported. Vendor provenance,
selected-version compatibility, provider admission and native child routing remain
separate blockers; none is inferred from a containment capability.

## Earned control capability

`buildNativeClaudeImage` layers an explicitly selected, bounded hash-checked ELF
and immutable controller helpers onto the existing privately earned pinned
Herdr/bubblewrap build. It accepts that exact in-memory build and Docker transport,
not an imported image label or copied build JSON. The output keeps
`vendorProvenance: false`: hashing bytes and observing a matching `--version` string
cannot prove that Anthropic published them. An official installer source audit
returned HTTP 403; no authenticated acquisition/digest route is implemented. No
installer or artifact was downloaded or executed for this checkpoint.

The Claude branch of `probeNativeRuntime` earns its private capability only after
checking exact image module hashes and the **whole native process** boundary, then
confirming exact probe-container stop. Bubblewrap provides fresh PID, mount and
network namespaces, drops capabilities, exposes the allocated root workspace and
fresh HOME/config only, and makes runtime code/settings read-only. Credential-free
probe controls test inaccessible sibling workspaces, private controller files and
socket, controller data through `/proc/<outer PID>/root`, and writable allocated
files. Outer and inner processes can share numeric PID 1; reading that number's
`environ` would test the inner process itself, so the control checks inaccessible
private data as well as distinct namespace identities. Native Read/Edit
are subject to the same outer kernel boundary as Bash. Network is completely
denied, including provider traffic; this is not a physical-request admission gate.
Failed checks or uncertain stop cannot issue the capability. The existing Codex
capability path is unchanged and cannot authorize this Claude runtime.

Only the collector's fixed hook-input directory is additionally visible read-only.
Its Unix socket is an intentional **untrusted input endpoint**, not the launcher or
Herdr control socket. The native process can send forged hook bytes; peer ancestry
establishes origin, never truth or complete accounting. Private retained evidence
stays outside every inspected runtime mount.

## Controller-created launch and foreground binding

`createNativeClaudeRuntime` requires the exact native `LeadContainer`, its actual
owner attachment, the private Claude capability, and the original prepared plan
object. Copies, edited public plan fields, labels and supplied fixture flags cannot
create a selection token. Its explicit methods start an isolated Herdr server and
allocate one owner-visible native pane; importing or constructing the controller
does not launch anything. There is no headless CLI or terminal-input path.

The fixed pane shell is the image's immutable Python launcher, selected through
Herdr's native `terminal.default_shell`/`shell_mode = "non_login"` configuration.
The controller independently reads that pane's `process-info` shell PID and kernel
lifetime, then compares them with the Unix socket's kernel `SO_PEERCRED` peer.
`HERDR_PANE_ID` is only an endpoint address. It never establishes pane authority.
The launcher starts its own bubblewrap `Popen` child, receives the original sandbox
child PID through `--info-fd`, and keeps that child blocked through `--block-fd`.
Before release it opens and retains a Linux **pidfd** for that exact child, checks
ancestry and start ticks, and refuses unavailable/signaled handles. No later PID,
port, command-line or victim-process search can adopt another lifetime.

Teardown also keeps the gate held: the pinned bubblewrap source ignores the
`--block-fd` read result, making EOF a release, and installs the sandbox child's
parent-death signal only later. The launcher checks pidfd open/signal support
before spawning. On failure it signals the retained original child handle and
requires exit readiness before closing gate descriptors. Missing identity, refused
signal or unconfirmed exit emits a controller failure and parks the immutable
launcher holding the gate until exact container stop; it never closes the gate or
claims cleanup succeeded. The controller retains stop uncertainty if containment
cannot confirm termination. This failure latch performs no PID search or adoption.

The passive collector listener is staged while the original child is held. After
release, the immutable launcher must observe that same lifetime executing the
selected native bytes at the allocated cwd. The controller independently brackets
native foreground/process-group membership with fresh Herdr and shell observations,
checks separate PID/mount/network namespaces, and only then activates its private
in-memory selection. The original pidfd, `Popen` handle, shell and owner attachment
stay live; fresh checks surround every collector data frame and repeat on a bounded
watchdog. PID reuse, changed executable/cwd/argv, foreground loss, namespace changes,
owner loss, controller failure or uncertain process evidence stop the exact owned
container. A passive listener reservation cannot authorize data before native
activation. Stop uncertainty is retained and never replayed as successful closure.

## Native source contracts

These are source audits of immutable local checkouts, not executed acceptance:

- Herdr `4812c9054cfce3e294a300c60d30d78d2a447d38`:
  `src/config/model.rs` declares terminal shell configuration;
  `src/config/io.rs` resolves release config under `XDG_CONFIG_HOME/herdr`;
  `src/pane.rs` creates the PTY child from that configured shell;
  `src/app/api/panes.rs` reads `runtime.child_pid()` and kernel foreground jobs;
  `src/api/schema/panes.rs` defines `shell_pid`, foreground group and processes.
  `src/cli/pane.rs::pane_run` uses `PaneSendInput`, so this runtime does not use it.
- The existing `createHerdrWatchRunner.createTab` creates a native pane through
  `tab create` (or initial `workspace create`) and parses its actual ID. The runtime
  uses only that allocation seam, never `runInPane` or `agent prompt`.
- Codex source `008bbd5884122dc95aaece19ecfe0fc6a59dcf36`, vendored
  `codex-rs/vendor/bubblewrap/bubblewrap.c`: `--info-fd` reports `child-pid`;
  `--block-fd` waits before exec; `--as-pid-1` preserves that original sandbox
  child's lifetime across exec; `--die-with-parent` supplements controller stop.
  The launcher separately retains a pidfd and does not treat numeric PID equality
  as an original-lifetime handle.

The [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and
[hooks reference](https://code.claude.com/docs/en/hooks) describe intended flags and
hooks. They do not prove the selected artifact's vendor, supported flags, effective
configuration, transcript layout or native UI behavior. Those actual checks remain
unrun. The existing plan's child definitions do not establish prelaunch allocation
or complete inventory of native subagents.

## Deterministic coverage and remaining acceptance

Fixtures exercise original-token identity, copied/mutated plan rejection,
listener-before-release ordering, independent pane/peer binding, PID reuse, original
pidfd exit/unavailability, teardown-before-gate-close ordering, missing identity,
kill refusal/timeouts, launcher exit/reuse, wrong executable, background native
processes, shared namespaces, owner loss and uncertain container stop. Image/probe
fixtures reject copied capabilities, wrong hashes/version strings, failed control
isolation and unconfirmed stop. These are transport/OS fixtures, not Docker or
native Claude acceptance. Removing the pidfd fence makes the lifetime tests fail.

Future authorized acceptance must establish official artifact provenance and
selected-version behavior, run the real containment probe, demonstrate the actual
owner-visible foreground and protected collector, and confirm descendant-wide
stop. Independent provider/account/quota observation, fail-closed admission for
every physical root/child/retry/compaction request, and prelaunch native child/index
routing are still unimplemented. No campaign or model request is enabled by this
source checkpoint; imported manifests, hook text, transcripts or success labels
cannot close any missing boundary.
