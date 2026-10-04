# Native integration checkpoint (build-only, incomplete)

This continuation adds executable worker transport, containment, protocol admission,
usage accounting and verifier engineering. It does **not** complete the native
Clankie evaluation arm. The historical Linux adapter reuses the landed candidate grader and pinned reports.
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

The verifier owns cleanup across creation and its first inspection. Once the
controller receives an exact container ID, a later inspection, execution or report
failure still stops that ID through the existing container lifecycle. Cancellation
while creation is pending prevents a later start; cancellation during cleanup also
prevents accepting a completed report. An ambiguous create response authorizes
neither name-based cleanup nor another create attempt.

`official-verification/container-stop.json` records the exact ID, stop outcome,
cancellation and completion/report error separately. Stop uncertainty takes
precedence over a passing report and reaches the manual result as
`terminal-bench-stop-unconfirmed`; ordinary report failure with confirmed cleanup
remains `verification-unavailable` with `verifierStopConfirmed: true`. Cleanup is not reported as confirmed without an exact ID and a confirmed stop.
Deterministic fake
command fixtures cover these transitions; this does not establish a live verifier
run, native child admission or permission to launch the held campaign.

Both verifier Dockerfiles create an empty `/app`; artifact-only mounting does not
hide their trusted support. Routing grader inputs/checker live under `/tests` and
the candidate is data-only JSON. Routing's initial environment files under `/app`
are staged from the pinned source manifest into the allocated task workspace. Source base tags/installers are
not immutable; source pins alone cannot replace recorded built image identities.

HTML's official grader executes `/app/filter.py` with `sys.executable` and permits
in-place input changes. Same-UID execution could forge reports, so HTML verification
requires a controller-built and separately probed mediation image. The Python bootstrap/trampoline preserves official grader
source/argv and snapshots input into a private writable copy inside a separate
credential-free PID/network/filesystem sandbox. It copies back only bounded owned
regular output after settled execution; exceptions or uncertain termination never
copy back. Fake-runner tests exercise these boundaries without executing candidate
code. The derived verifier image build, nested-sandbox capability origin/probe and
bridge wiring now have deterministic fake-container coverage. The future probe
checks the actual trampoline path, forbidden grader/log/parent access and detached
descendant settlement; no image or probe has been run. Missing same-controller,
exact-image/daemon proof refuses verification. A trusted mediation-failure marker
invalidates even an otherwise passing official report. There is no unsafe fallback.

## Integrated engineering and remaining runtime proof

- The actual `HerdrWatchStore` → adapter → fake WS-provider hire fixture now covers
  effective-profile responses, pane proof, isolated path/account mapping and loss
  of owner/proxy/audit channels. A trusted preparation seam avoids ordinary host
  account probes and skill overlays. Capability substitution is explicit fixture
  evidence, never proof of a live sandbox.
- Positive fake Docker origin-chain tests cover native and HTML builds/probes,
  copied-proof rejection and changed-daemon refusal; pinned routing inputs stage
  without exposing held-out graders.
- Clankie's optional eval session seam uses a controller-supplied runtime, inert
  text snapshots, no resource/package/extension discovery and immutable in-memory
  settings with cache warming off. Defaults retain ordinary production behavior.
- Lead coding helper/tool wiring now uses fixed native sandbox argv, bounded text
  operations, separate helper-path capability checks and descendant settlement.
  The Pi bash executor is replaced because its output accumulator can write host
  temporary files. This path has fake-process/container tests only.
- Final physical SSE transport has bounded plain/zstd validation, fixed model and
  effort, final account/header checks and hash-chained request/usage records.
  The immutable provider runtime and actual controller → Captain → installed Pi
  fixture exercise a contained read and compaction. Each physical request rechecks
  the selected observer credential after all asynchronous admission work. Active
  requests share the exact container stop signal. These fixtures do not establish
  actual subscription or sandbox capability.
- The explicit manual bootstrap composes an isolated service, independent archived
  repositories/indexes, native hires, owner attachment and one read-only observer
  per distinct selected account. Observer snapshots carry private one-use origins;
  all accounts cross one readiness barrier before lead or worker dispatch. A
  separate owner-proof watchdog stops even when the proof RPC hangs. First/latest
  quota windows and raw lead/native usage ledgers remain distinct evidence.
- The official task environment image is the native image's final base. Its exact
  Python version, package versions and trusted initial files are checked by the
  future credential-free capability probe; generic distro Python is not accepted
  as the benchmark environment. The HTML verifier retains its separate mediated
  candidate boundary. Cancellation stops its exact verifier container.
- Production defaults and the disabled campaign run entry remain. The manual
  bootstrap now wires the pinned historical tasks through controller-staged exact
  dependency inputs, a Linux dependency image, complete before/after calibration,
  independent dependency materialization and the existing candidate grader. Missing
  prerequisites return unsupported before account startup. No native build,
  capability probe, auth import, provider call or campaign has been run.
- Owner TTY edits/interventions are not measured. Never-started allocations are
  separate from started workers lacking token counters; incomplete accounting
  produces unknown totals rather than zeros. Each native turn needs its exact
  start, token counters and successful completion before totals become complete.
  A later active, interrupted or unaccounted turn invalidates complete totals;
  dispatch records are latched immediately before the physical native request.
- Claude subscription/account coverage and arbitrary descendant prelaunch fencing
  remain unsupported; refusal is separate from James's explicit campaign hold.

Focused tests use local fake services/processes/providers, disposable repositories
and pure protocol/helper fixtures. They do not establish native runtime capability,
benchmark quality or owner-authorized campaign completion. Full checkpoint gate
results and source manifests are retained outside the repository in the authorized
VUH-1474-native evidence directory. Earlier failed logs remain intact. No CI,
scheduler, release or post-reset path dispatches this evaluation.

During fixture development, omitted isolation options in earlier Captain tests
may have attempted read-only owner Herdr census/terminal resolution. Exact tests
and retained logs are recorded in the external evidence directory. Those fixtures
now use explicit scoped fake runners or disabled Herdr availability, with test-local
ambient-process tripwires. No mutating fleet, account, model or container operation
was authorized or performed as part of these checks.

## Historical Linux prerequisites and evidence

For a historical selection the strict private manual configuration additionally
requires `historicalBuild: { platform, nodeImage, pnpmTarball, pnpmSha256 }`.
`platform` is explicitly `linux/amd64` or `linux/arm64`; `nodeImage` must be the
same digest-pinned `node:24.20.0-bookworm` image as `nativeBuild.nodeImage`.
The private, bounded `pnpmTarball` is independently SHA-256 pinned and must contain
pnpm 11.11.0. No ambient host dependency tree or default platform is accepted.
The existing native Rust source/toolchain pins remain required; the daemon and
Rust, dependency and composed native images must match the selected Linux platform.
These inputs describe a future explicit manual run, not permission or a run result.

The dependency recipe copies only the selected base's 51 package/lock/workspace,
patch and vendored-package inputs, performs a frozen dependency installation and
builds the required native artifacts. Installation occurs only in that controller
image build. Candidate and grader invocation do not install packages. Private
in-process capabilities bind the actual image, daemon/socket, input profile and
native artifact hashes; exported JSON receipts cannot restore this authority.

Calibration requires all pinned files and assertion counts on both revisions,
unique matching test identities, finite durations and no missing/skipped tests.
The before revision must execute failed assertions, and the fixed revision must
pass the existing strict validator. An import crash cannot establish calibration.
Reports retain actual outcomes; no failure-to-pass bookkeeping normalization is
used as benchmark evidence. The held-out verifier sees a read-only source tree,
network none, separate writable reports and exact container stop receipts.
The existing in-process reporter limitation remains: these checks do not provide
cryptographic resistance to candidate code sharing the report-producing process.

After confirmed native shutdown, patch collection copies only regular source
files into a fresh trusted repository; host Git never loads native-edited Git
configuration. Protected candidate preparation and the existing grader then run
against separately materialized dependencies. Only the lead's integrated changes
are graded. Owner interruption precludes new grading. The fake fixture checks
exercise these paths without Docker, builds, installs or real grading. Actual
Linux before/after calibration and every historical/native run remain **unrun**.
The native Claude arm remains separately unsupported.

See [the native Claude partial engineering checkpoint](native-claude-continuation.md)
for its prepared interactive launch specification, bounded observational accounting
and exact remaining capability blockers. No Claude runtime is launch-enabled.
