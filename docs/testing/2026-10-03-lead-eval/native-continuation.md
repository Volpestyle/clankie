# Native integration checkpoint (build-only, incomplete)

This continuation adds executable worker transport, containment, protocol admission,
usage accounting and verifier engineering. It does **not** complete the native
Clankie evaluation arm. The landed historical candidate grader remains separate.
`lead.mjs run` still refuses dispatch; the service entry point does not activate
this factory. No model, native agent, provider/account probe, container build or
execution, benchmark, live service or owner fleet operation was performed.

## Worker flow and trust boundaries

`lead-native-runtime.mjs` supplies optional `CaptainOptions` for the existing
`hireSeat` → `HerdrWatchStore` → Codex adapter flow. One exact container contains
one Herdr socket and several controller-preallocated repositories with independent
indexes, native auth homes, wrappers and app-server endpoints. Host/container cwd
mapping is explicit. Foreign fleets, resume, Claude and arbitrary native descendants
are refused. Preparation admission precedes account/skill lookup; final admission
checks the exact allocated account/home/model/effort before native creation.

Both app-server and interactive TUI receive complete clean environments. The
controller writes the immutable native wrapper with the exact pane ID and argv.
Service bearers and ambient provider keys never enter either launch. Candidate
command tools receive a named root-deny filesystem profile with allocated workspace
writes, read-only git metadata, protected project configuration, no network and no
multi-agent. Provider transport remains available to the native parent. The service,
broker, controller and monitor remain host-side. No service socket/bearer is mounted
into candidate-readable state. These are implemented restrictions, not a claim that
an unexecuted runtime image has demonstrated isolation.

`lead-native-proxy.mjs` is an actual WebSocket/JSON-RPC proxy, bundled with installed
`ws` by `lead-native-proxy-build.mjs`. The native TUI uses this proxy; the controller
uses Codex's shipped app-server proxy through Docker's explicit exec stream. Neither
path types terminal input. A deny-default method/field policy and private one-use
host decisions precede native thread creation and every model-producing turn.
Known alternate execution RPCs, unknown methods, local path/image/skill imports,
output schemas and model/effort overrides are rejected. Native initialization keeps
its real experimental capability flag. Its lossy legacy workspace-write request is
explicitly converted to the locked named profile. The host checks the returned
model, effort, cwd, roots and effective profile before binding the native root.

A trusted `config/read` with layers at the exact cwd validates effective settings
before creation and turns. It is not exposed to candidate proxy clients. Unknown
configuration layers or additional hooks, MCP, plugins or provider settings refuse
admission. Empty maps do not delete inherited config: launch state also requires
fresh protected authentication state and absent/immutable workspace config layers.

Herdr binding uses the exact native binary hash, PID/start time, controlling TTY,
fixed pane environment and reciprocal kernel Unix peer inode/path proof, then
reports and reads back the exact Herdr session. Owner attachment uses a separate
controller-created native Herdr client and the same peer proof for the actual
`herdr-client.sock` derived from `herdr.sock`. Boolean visibility claims are refused.
Owner input cannot bypass pre-turn admission. Initial controller briefs also
recheck their host authority after async readiness/native admission waits.

Owner client, proxy, audit stream and control-pipe loss stop the exact boundary.
Stop revalidates controller-created container ID, immutable image, role/run labels,
mounts and security settings; there is no broad name/label cleanup or reconnect.

## Runtime capability and provider accounting

`lead-native-image.mjs` implements a source-pinned image build from exact git
archives, pinned base-image digests and locked native builds. `lead-native-capability.mjs`
implements a credential-free capability probe using harmless canaries and the
shipped native Linux sandbox command. The controller-origin build/probe records
are branded in memory and bind source, image, binaries and exact Docker daemon/socket.
Imported JSON cannot authorize native create/start/exec/attach. The probe code has
**not been executed**, nor has an image been built under this hold. No genuine
capability record therefore exists from this continuation.

The primary source pin is OpenAI Codex
`008bbd5884122dc95aaece19ecfe0fc6a59dcf36`; Herdr is
`4812c9054cfce3e294a300c60d30d78d2a447d38`. Codex's
`account/sessions/list` has orphan types but no registered handler and is refused
at both type and runtime boundaries. Fake support was removed.

The real rate-limit handler compares backend account and user IDs with selected
native authentication before returning `ordinaryUsageAllowed`. The monitor
requires that flag, the exact account ID, known spend-control state and both
five-hour/seven-day windows. Account/read before/after is a consistency check;
email alone is not authenticated account binding. Missing, stale, unknown or
exhausted telemetry refuses admission and independently stops the boundary.

`lead-native-ledger.mjs` keeps a full hash-chained native ledger alongside the
unchanged bounded UI summary. It checks all paginated native inventory roots,
workspace/account attribution and cumulative token events before UI filtering.
The direct trusted audit stream is the sole usage writer; proxy notifications
cannot double-count or reorder cumulative totals. Unadmitted descendants refuse
execution; multi-agent remains disabled. Parser tests are not evidence of complete
live account/process coverage.

## Official Terminal-Bench bridge and remaining verifier work

The official source/license pins remain unchanged at
`452bf305c6daa62fc59061d22133a7cbc7c1572e`. The bridge validates each task subtree
and file hash, stages separate environment/verifier contexts without solutions,
binds built immutable image IDs, and reads only bounded owned regular reports.
Pinned test.sh writes `/logs/verifier/ctrf.json`; the actual pytest-json-ctrf 0.5.2
source establishes the case-name schema. Passing requires complete named case
coverage and consistent reward, not exit zero alone.

Both verifier Dockerfiles create an empty `/app`; artifact-only mounting does not
hide their trusted support. Routing grader inputs/checker live under `/tests` and
the candidate is data-only JSON. Routing's initial environment files under `/app`
still need staging into the native task workspace. Source base tags/installers are
not immutable; source pins alone cannot replace recorded built image identities.

HTML's official grader executes `/app/filter.py` with `sys.executable` and permits
in-place input changes. Same-UID execution could forge reports, so HTML verification
currently refuses. The new Python bootstrap/trampoline preserves official grader
source/argv and snapshots input into a private writable copy inside a separate
credential-free PID/network/filesystem sandbox. It copies back only bounded owned
regular output after settled execution; exceptions or uncertain termination never
copy back. Fake-runner tests exercise these boundaries without executing candidate
code. The mediated verifier image, nested-sandbox capability origin/probe and full
bridge wiring are **not finished**. There is no unsafe fallback.

## Checkpoint limits and next implementation

- Complete the deterministic `HerdrWatchStore` → actual adapter → fake WS-provider
  hire fixture, including effective-profile response, pane proof and path mapping.
- Add full positive fake Docker build/probe-origin-chain fixtures and integrate the
  HTML mediated image/probe and native initial Terminal-Bench inputs.
- Isolate Clankie's own built-in read/bash/edit/write tools: the current production
  lead session still uses host-user tools. Add optional tool overrides plus hard
  provider/compaction admission and complete lead account/usage enforcement.
  Swallowed extension callbacks cannot serve as that boundary.
- Wire an explicitly manual private throwaway service bootstrap only after those
  boundaries are reviewed. Production defaults and the disabled run entry remain.
- Claude subscription/account coverage and arbitrary descendant prelaunch fencing
  remain unsupported; refusal is separate from James's explicit campaign hold.

Focused tests use local fake services/processes/providers, disposable repositories
and pure protocol/helper fixtures. They do not establish native runtime capability,
benchmark quality or owner-authorized campaign completion. Full checkpoint gate
results and source manifests are retained outside the repository in the authorized
VUH-1474-native evidence directory. Earlier failed logs remain intact. No CI,
scheduler, release or post-reset path dispatches this evaluation.
