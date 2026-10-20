# Worker bridges and fleet tools

Remote project heads, connected tools for fleet panes, bridge health in doctor and the roster, local harness processes, preparing linked machines, and Windows fleets. Hiring, report routing and receipts are in `lead`'s [fleet tools](../../lead/reference/fleet-tools.md). The tool-access contract is `{repoRoot}/docs/worker-access.md`; flags and doctor fields are in `docs/cli.md` under `doctor`, `access`, `mcp --fleet`, `herdr prepare` and `metrics --fleet`.

## Remote project heads

Launch, accounts, link-failure recovery and the tracker fence for remote project
heads are in `lead`'s [project leads](../../lead/reference/project-leads.md); the
CLI contract is `docs/cli.md` under `conversations lead`. Bridge and plugin
specifics:

- Launch installs the dedicated `clankie-remote-lead@clankie-remote-leads` plugin
  and approves its channel before allocating a pane; a setup refusal lands in the
  original launch journal. Never answer a development warning or substitute the
  worker channel. `dispatched` proves handoff only; verify a native tool call
  after deploy.
- Relaunch keeps the user-scope lead plugin disabled for ordinary sessions. Do
  not close a previous head's pane to repair an already-disabled setup result;
  its revoked delegation stays revoked, and cleanup is the owner's decision.
- A source-only missing-bridge refusal names `clankie heavy -- node
scripts/build-remote-lead.mjs`.
- `~/.clankie/remote-leads/hooks.log` on that machine records hook timing; a short
  hook timeout does not retire or restart the lead
  ([native seat transcript sync](../../../../docs/cli.md#native-seat-transcript-sync)).
- A launch's early pane report is cleanup information, not native admission or
  permission to replay the launch. Inspect the original receipt and coordinate
  cleanup; do not close another lead's pane as a probe.
- Remote heads get ordinary `linear_*` tracker tools from the bound lead chat;
  Claude's inherited tracker connector is never a substitute. Other connected
  services, raw GraphQL, owner repository overrides, worker publishing and owner
  settings are not delegated. After a relaunch, verify an issue read and comment
  from the actual head.

## Connected fleet tools

Admitted panes in a Clankie-linked session reach verified accounts through exactly
`clankie_tools` and `clankie_call` (served by `clankie mcp --fleet`); the worker
plugin adds `message_clankie`. `fleet.tools` defaults to `connected`; `clankie fleet
set --tools off` stops new standing admissions, and disconnecting a fleet removes
admission. Every provider call rechecks admission, setting and account. A call
already past its last check can still reach a provider after `off` or revocation:
strict refusal is not guaranteed (ADR 0217).

Missing tools do not authorize an operator lane or another Linear connector; ask
the lead to inspect link admission, `fleet status` and the connected account.
Project grants, cwd and native sessions do not gate fleet tools. Outward-facing
sends still need the owner's instruction, and the identity remains Clankie's
connected account.

A manual grant (`clankie access issue REQUEST.json --out GRANT.json` for `clankie
mcp --grant FILE`, at most 15 minutes; `access list`, `access revoke ID`) is a
private file: never share operator bearers or grant contents in transcripts.
Worker publishing grants must pin the exact `personaId`. Shared Linear tools:
`clankie access linear` and `clankie access linear verify`, checking the intended
automation identity.

A worker's first `tools/list` waits up to 20 seconds for native membership to
settle; without admission only `message_clankie` remains. A managed Codex catalog
refresh (`catalog-refreshed`) proves only the native catalog: check `clankie_tools`
in that same worker thread and store one distinct `message_clankie` report before
claiming end-to-end recovery. Catalog reads cannot override owner tool-exposure
settings. Inspect the specific refusal instead of treating every missing
capability as a project grant.

## Bridge health in doctor and the roster

`clankie doctor` (or `clankie doctor --machine FLEET_ID`) reports profile version,
enabled state, bridge, hooks and the `clankie` skill as independent facts; static
installation is not live membership. `doctor.harnessBridges`, roster
`harnessBridge` and `workerTools` report process membership and observed catalogs;
`unobserved`/`not-observed` means facts are unavailable, never "missing", and none
of these observations grants tool authority. Roster samples live five seconds;
`Ctrl+G` in the console shows a pane's full fix.

- A persistent Claude native-binding failure: `/mcp` → reconnect `clankie-worker`,
  then save and restart/resume if needed. Transport failures need the fleet
  link/SSH diagnosis from Clankie's machine, not another pane's restart. A late
  reply after `remote_observation_timeout` is never fresh proof.
- A shared Codex app-server daemon cannot prove its pane (`linkedSession`
  `missing`/`pane-mismatch`, `unownedBridges`). Save affected sessions; the owner
  can stop the daemon and resume each with `codex --no-daemon resume <SESSION>`.
  Do not stop another agent's daemon as a diagnostic step.
- A hand-started Claude pane reporting `missing` needs the worker plugin in that
  pane's own profile: `claude plugin install clankie-worker@clankie --scope user`,
  `claude plugin enable clankie-worker@clankie --scope user` (after `claude plugin
marketplace add <repoRoot>/integrations/claude-plugin` if absent), then
  restart/resume and verify the fresh catalog lists `message_clankie`,
  `clankie_tools` and `clankie_call`. Preserve source-owned settings and symlinks.
- After an owner-authorized same-thread Codex reattach, `clankie agents readopt
SEAT --conversation ID` repairs the owning conversation's binding.
- A Codex seat on a worker plugin older than 0.6.5 shows `restart needed`;
  automatic legacy restart is disabled, and its remediation names the manual path
  (retain the handoff and evidence, settle original receipts, close it idle, hire
  fresh). Never replay an uncertain report or claim the new hire resumed the old
  thread. `clankie harness restart-tools` is not that path.
- Roster `workerReportBridge` records the last report outcome; idle hires without
  a report since their brief show `finished, unreported`. `clankie metrics --fleet`
  gives proof, refusal and report-failure rates. Health observations never
  authorize deleting receipts or replaying reports.

Unread worker output: `clankie agents reports --conversation ID`, acknowledged
with `reports ack` on the exact returned page. `reports ack-history` (operator
credentials, explicitly selected IDs) is for owner-authorized history cleanup;
never clear new unread reports as part of a migration cleanup.

A pre-dispatch `fleet_admission_unavailable` 503 is retried once by the bridges; a
definite `local_process_membership_required` 403 asks for admission and is not
retried. Read the terminal proof reason and refusal rate before treating churn as
lost membership, and keep PID/birth private when publishing evidence. Refusal
reasons and ancestry rules: `{repoRoot}/integrations/fleet-proof/README.md`.

Remote reports include `linkState` (an `unreachable` link's decoded reason) and
per-pane eligibility; `nativeTools: "not-verified"` means that pane's bridge,
catalog and reply delivery are unchecked, so confirm them through the native
harness. Read the reported reason rather than closing unrelated SSH masters.

## Local harness processes

`clankie fleet processes` is the read-only operator census. A thread log mtime is
only an activity proxy, and detached Codex app servers intentionally survive
service replacement. Age, PPID 1, an absent pane or a recorded pane name alone
never authorizes killing. `clankie fleet processes retire` can TERM only a
controller-created server whose original hire is proven closed and idle;
everything else stays report-only. Never retry an uncertain retirement or fall
back to `kill`, group signals or KILL. Conditions: `docs/cli.md` under
`fleet processes`.

## Preparing linked machines

`clankie harness install [--project PROJECT] [--approve]` and `clankie herdr prepare
FLEET_ID [--project PROJECT] [--approve]` follow `fleet.machineSetup`: under `lead`,
existing authorized access may prepare Clankie's own setup on an already-linked
machine; under `owner`, get explicit approval. `--approve` needs an interactive
terminal. A new source setup script needs owner consent under either policy.
Setup preserves source/account fences and never restarts or steers an existing
lane.

Updates refresh existing links automatically (`--refresh-linked`); read the
per-profile receipts, since a healthy update can still report
`harness-refresh-incomplete` or `source-manager-required`. Generated or symlinked
Codex configuration needs its source-owned setup (`clankie herdr prepare NAME
--codex-source-setup ABSOLUTE_REMOTE_SCRIPT`), never TOML appends; never replace a
settings symlink to work around a refusal. Preparation is incomplete while native
version, activation, bridge, identity forwarding or skill checks fail. Read
`clankie doctor --machine NAME` afterwards: installed files are static proof, so
do not restart another lane's pane or claim native tools were tested. OpenCode,
Pi and Grok setup gaps are reported, not called ready.

## Harness auto-updates

Native proof accepts the installed harness or another release of the same install
that an auto-update left running (paths differing only in one version-named
directory or file). A seat on an older release keeps fleet tools and peer
messaging; `workerTools.harnessUpdate` names it. Resume the same thread when idle
to run the current release.

## Windows fleets

A Windows fleet admits its live stream and pane for connected tools through a
service-owned SSH relay; loss of the connection denies tools. Native project, hire
and mailbox proof still observes process lifetime, ancestry, executable and cwd.
Register project workspaces with the fleet's own machine ID
([trust contract](../../../../docs/remote-process-proof.md)). Only an owner-run
pane check establishes that a real pane sees its native catalog.

For repeated Claude catalog warnings, compare the native plugin cache with the
prepared marketplace; ship a new worker version and use `clankie herdr prepare
FLEET_ID`, then coordinate save/restart/resume with that pane's owner rather than
steering another lead's session. Service-created Windows Codex hires require the
exact worker bridge shipped with the service, refuse a stale or changed
installation before the first brief, and wait for `clankie_tools`, `clankie_call`
(while fleet tools are on) and `message_clankie`. An uncertain hire is not
permission to retry or type into its pane. Config inspection never proves a live
socket or tool acceptance; preserve generated config and use its owning setup.
