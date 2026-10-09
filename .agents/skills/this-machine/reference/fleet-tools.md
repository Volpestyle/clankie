# Worker bridges and fleet tools

Connected tools for fleet panes, bridge health in doctor and the roster, worker report routing, preparing linked machines, and Windows fleets.

Remote project heads use `clankie conversations lead launch --json-stdin` on an
approved Windows fleet/workspace. They reuse an existing signed-in Claude.ai
profile, install the dedicated `clankie-remote-lead@clankie-remote-leads` plugin
and approve its channel before allocating a pane. Profile ambiguity, missing
sign-in or administrator policy access returns a setup refusal in the original
launch journal. Never answer a development warning or substitute the worker
channel. `dispatched` proves handoff only; verify a native tool call after deploy.
Relaunch preparation keeps the user-scope lead plugin disabled for ordinary
sessions. Native Claude's exact already-disabled result is accepted only with a
disabled-state readback. A previous head may still have session-only activation;
do not close its pane to repair an already-disabled setup result. Its revoked
delegation remains revoked; any cleanup is a separate owner decision.
Runtime updates build the standalone bridge before cutover; a source-only
missing-bridge refusal names `clankie heavy -- node scripts/build-remote-lead.mjs`.

Remote heads get ordinary `linear_*` tracker tools from the bound lead chat.
Use their tracker-only `mcp_tool_search` / `mcp_tool_call` for tools beyond the
initial list. Writes require current seat delegation and chat attribution; do
not substitute Claude's inherited tracker connector. Other connected services,
raw GraphQL, owner repository overrides, persona-selectable worker publishing and owner settings are not
delegated. `linear_wake` only confirms `action: received` with a wake's original
`wakeId` in this chat. Configure project wake routing as the owner through
`clankie linear routes set --json-stdin`, preserving existing routes. After
redeploy/relaunch, verify an issue read and comment from the actual head.

## Connected fleet tools

Admitted panes in a Clankie-linked session reach verified accounts through exactly
`clankie_tools` and `clankie_call`; the worker plugin adds `message_clankie`.
Search qualified names/descriptions, request selected schemas, then call with
`{name, arguments}`. Use `clankie mcp --fleet` for the fleet connected tools.
`fleet.tools` defaults to `connected`; `clankie fleet set --tools off` stops new
standing tool admissions, and disconnecting a fleet also removes admission. Bearer
links prove a fleet, without mailbox authority. Every provider call retains live
admission, setting and account checks. A call already past its last asynchronous
check can still reach a provider after `off` or revocation: no global in-flight
cancellation or concurrency bound exists, so strict refusal is not guaranteed
(ADR 0217).

Missing tools do not authorize an operator lane or another Linear connector.
Ask the lead to inspect link admission, `fleet status` and the connected account.
Project grants, cwd and native sessions do not gate fleet tools. Projects keep
roles, caps, hiring and tracker binding. Local discovery carries no bearer.
Outward-facing sends still need the owner's instruction; the connection identity
remains Clankie's connected account.

Unverified accounts and persona-bound worker publishing are excluded. For an individual
manual grant, `clankie access issue REQUEST.json --out GRANT.json` creates a
private file for `clankie mcp --grant FILE`; tokens last at most 15 minutes.
Use `access list` and `access revoke ID` to inspect or revoke.
Never share operator bearers or grant contents in transcripts. Exact
`tools[].arguments` and `forbiddenArguments` enforce resource restrictions.
Worker publishing grants must pin the exact `personaId`. Read
`docs/worker-access.md` under `repoRoot` for the contract.

For shared Linear tools, inspect `clankie access linear`; verify an API-key
or OAuth connection with `clankie access linear verify` and check the intended automation identity.

The worker bridge gives its first `tools/list` up to 20 seconds to retry with
backoff while native pane membership settles, including any stalled HTTP lookup.
Fleet admission and the connected-tools setting must permit discovery; otherwise
only `message_clankie` remains. Later lists and every call still check current
access. Codex 0.161's managed original-controller refresh reloads MCP and rebuilds
tools at the next sampling step. A `catalog-refreshed` result proves only the
connected native catalog; model exposure and report delivery remain unverified.
Check `clankie_tools` in that same worker thread and store one distinct
`message_clankie` report before claiming end-to-end recovery. Native catalog
reads cannot override owner tool-exposure settings. New calls from a displayed stale
catalog are checked live. Native identity checks for worker messages, peer delivery and project assignments
remain separate from connected-tool admission. Connected tools require the linked
fleet and verified account, not a project or cwd proof (ADR 0217). Inspect the
specific refusal instead of treating every missing capability as a project grant.

For missing native fleet tools, inspect `clankie doctor` or `clankie doctor
--machine FLEET_ID`: profile version, enabled state, bridge, hooks and `clankie`
skill are independent facts. Static installation is not live native membership.
Doctor and roster `workerTools` separately report observed worker catalogs,
pending requests, missing tools and stalled reads with their reasons. An unknown
catalog remains `not-observed`; those observations grant no tool authority.

## Bridge health in doctor and the roster

Claude's pane tool-check warning names timeout, connection refusal or the exact
HTTP/native-binding refusal. The idle observer retries through fresh link
discovery; each cause is logged once per Claude session, even across healthy checks.
For persistent native binding failures, use `/mcp` → reconnect `clankie-worker`,
then save and restart/resume Claude if needed. Transport failures need the PC
fleet link/SSH diagnosis from Clankie's machine (`clankie doctor --machine pc`),
not another pane's restart. A remote observer timeout appears as
`remote_observation_timeout` and in the fleet-link log; its original late reply
is never accepted as fresh proof. Keep uncertain message receipts untouched.

`doctor.harnessBridges` reports the worker bridge separately from the operator
seat: Claude plugin installation/enabling, Codex registration and generated config
source, and live local process membership. A shared Codex app-server daemon cannot prove its pane. Inspect
`doctor.harnessBridges.linkedSession` for per-pane `missing` / `pane-mismatch`
observations and `unownedBridges` for actual daemon bridge PIDs and inherited
pane claims. Save affected sessions, then the owner can run
`codex app-server daemon stop` and resume each in its own pane with
`codex --no-daemon resume <SESSION>`; keep `daemon_auto_start=false` in the
source-owned config. Do not stop another agent's daemon as a diagnostic step.

For a hand-started Claude pane with `missing`, use that pane's actual Claude
profile: `claude plugin install clankie-worker@clankie --scope user`, then
`claude plugin enable clankie-worker@clankie --scope user`, and restart/resume.
An absent marketplace needs `claude plugin marketplace add
<repoRoot>/integrations/claude-plugin` first. Preserve source-owned settings and
symlinks; use `CLAUDE_CONFIG_DIR` for an alias profile. Verify the fresh native
catalog lists `message_clankie`, `clankie_tools`, and `clankie_call`, then make a
bounded connected-tool read.

Doctor's `linkedSession.nativeBindings` distinguishes observed, recovered and
missing session proof. Local Codex `--remote … resume THREAD` reattachments are
recovered only from the exact retained seat server/socket/thread lifetime.
After an owner-authorized same-thread reattach, `clankie agents readopt SEAT
--conversation ID` repairs the existing owning conversation's occupant binding.
Unread worker output is available through `clankie agents reports --conversation ID`;
reading leaves it unread until the lead acknowledges the fully offered IDs.
Use `clankie agents reports ack --json-stdin --conversation ID` with the exact
returned page, or pass its `ackDeliveryIds` as positional arguments. For an
owner-authorized history cleanup, `reports ack-history DELIVERY_ID...` accepts
up to 1,000 explicitly selected retained IDs and requires operator credentials.
Never clear new unread reports as part of a migration cleanup.

The roster's `harnessBridge` flags the same process facts; `Ctrl+G` in the
console reveals the selected pane's full fix. `live-process` verifies process
ancestry/dedicated socket and matching pane/socket environment only, not tools
or reply delivery. `unobserved` means facts are unavailable, never "missing".
The local host observation currently supports macOS; remote/Windows native
acceptance remains separate. Roster samples live for at most five seconds;
explicit doctor reads probe again.

Local Codex seats on worker plugins before 0.6.5 show `restart needed` and retire
naturally. Automatic legacy restart is disabled. When the lead chooses to retire
one, retain its handoff and original thread/evidence references, settle original
receipts, verify idle/no draft, close it through the existing tidy path, then
hire a fresh worker with the current plugin and that handoff. The old thread's
evidence stays on disk. Never replay an uncertain report or claim that the new
hire resumed the old thread. `clankie harness restart-tools --pane PANE` remains
a canonical-pane compatibility refusal: `native_exit_unavailable` occurs before
any close intent. It is not this manual path. Remote/Claude recovery is separate.
Roster `workerReportBridge` separately records the last report outcome, time and
fixed safe reason. Done/idle hires held for fifteen minutes without a stored
report since their latest brief carry `finished, unreported`. Three failed seats
within ten minutes produce one native alert to their owning lead. Inspect
`clankie metrics --fleet` for five- and sixty-minute proof/refusal and report
failure rates. Preserve and reconcile uncertain originals; health observations
never authorize deleting receipts or replaying reports.

Native `process_census_changed` with `retry: false` can accompany a successful
admission: changing PID lists are reconciled and every candidate is inspected.
Unrelated descriptor/process races retry that PID within the existing job budget.
Instability after a matching socket observation requests a fresh bounded census
to include new inheritors. Read the
terminal proof reason and refusal rate before treating a churn counter as lost
membership. A pre-dispatch `fleet_admission_unavailable` 503 means proof is
temporarily unavailable; Claude and Codex bridges retry once, then explain how
to retry or ask the lead to inspect persistent uncertainty. A definite
`local_process_membership_required` 403 asks for admission and is not retried.
`caller_exited` confirms that the socket claimant exited. `ancestor_exited`
confirms an intermediate exited while the same claimant lifetime was checked
live; it does not establish membership. The native helper can re-walk once
within the same budgets, revalidating that claimant and socket and discarding
the old chain. A second exit or changed/unavailable identity refuses; a
non-member is always refused from its current ancestry. Join private native `ancestryFailure`
facts and `fleet.local_proof.refusal_context` by the existing `requestId` for
failure-time liveness and the zero-based failed chain position. Keep PID/birth
private when publishing evidence; previous caller observations do not prove
current liveness. An earlier uncertain call still requires its original receipt.
Proof-refusal floods also alert the owner's default conversation, even when the
caller has no identifiable or currently owned pane. The aggregate notice names
counts and reasons; it does not attribute the requests to a seat. Logs omit pane
IDs, so an absent log field alone does not mean the collector lacked one.
Details: `{repoRoot}/docs/worker-access.md` and
`{repoRoot}/integrations/fleet-proof/README.md`.

Remote reports also include `linkState`: an `unreachable` link's `error` is the
decoded remote reason, independently of harness installation health. Fleet
control connections and resident relays refresh at ten minutes; renewal keeps
the link ready and drains accepted requests before closing the old relay. A failure before
the remote program starts retries once with a fresh login environment. Read the
reported reason if it remains down rather than closing unrelated SSH masters.
The selected remote machine also reports host-observed eligibility per pane,
including actual cwd, native session and hire state. `nativeTools: "not-verified"`
means it has not checked that pane's bridge socket, catalog or reply delivery;
confirm those through the native harness. Unavailable observations stay unproven.

## Worker report routing

Reports reach the hiring or adopting conversation; the worker never chooses.
`workerReportRouting` on the roster and `linkedSession.parentLeads` in doctor
show the route and any lead pane missing a bridge. Routing rules and recovery:
`lead`'s [fleet tools](../../lead/reference/fleet-tools.md#report-routing).

## Preparing linked machines

`clankie harness install [--project PROJECT] [--approve]` and
`clankie herdr prepare FLEET_ID [--project PROJECT] [--approve]` read the effective
`fleet.machineSetup` policy. Under `lead`, existing authorized access may prepare
Clankie's own setup on an already-linked machine; under `owner`, obtain explicit
owner approval. `--approve` requires confirmation in an interactive terminal;
it is refused headlessly. A new source setup script needs owner consent under
either policy; automatic setup uses the native plugin manager or an exact,
already-remembered source setup. The server records consent as a caller claim,
not verified human presence. Setup preserves source/account fences and never restarts or
steers an existing lane.

Updates and checkout/release installs automatically refresh existing links on
this machine and enabled SSH fleets with `clankie harness install --refresh-linked`.
Direct refresh rechecks current policy and linkage for each target; supply the
owner's interactive `--approve` confirmation under `owner`. Automatic installer refresh maintains
existing links within the already-authorized update.
Check its per-profile/fleet receipts: missing managed Codex source setup stays
`source-manager-required`, and a healthy runtime update may still report
`harness-refresh-incomplete`. Owner-approved source setup is remembered for the
same config source. Older native plugin clients get a once-only pane flag asking
the owner to save and restart/resume that harness; nothing is restarted for them.
If `notices.state` is `deferred`, restart flags await an updated service connection.
Generated/symlinked Codex configuration requires its source-owned setup, never
TOML appends. OpenCode/Pi/Grok setup gaps are reported, not silently called ready.

For a source-managed remote Codex config, use
`clankie herdr prepare NAME --codex-source-setup ABSOLUTE_REMOTE_SCRIPT` with its
owning setup. Such a script (for example a dotfiles setup that owns the
configuration symlinks) uses native plugin installation and renders the generated
source directly. Clankie preserves the runtime link and unrelated settings.
Preparation is incomplete if native worker version, activation, bridge, identity
forwarding or skill checks fail, even with a legacy MCP registration. Read
`clankie doctor --machine NAME` after preparation. Installed files are static
proof; do not restart another lane's pane or claim native tools were tested.

A stale Claude alias profile may use `herdr prepare NAME` to update only its
existing plugin cache when its settings point to another discovered unmanaged
profile and already enable the shipped plugin. Preparation preserves the shared
settings link and bytes; generated sources or disabled/missing alias plugins
still require the owner's source setup. Read the per-profile refusal before
retrying; never replace a settings symlink to work around it.

Repeated native Claude setup may report "already enabled at user scope" with an
error exit, prefixed by `×` on Windows or `✘` on macOS. Preparation accepts only that exact result after confirming the same
regular profile still enables the plugin; other errors or changed links remain
failures. A setup result is never live tool or socket acceptance.

## Harness auto-updates

Local native proof accepts the installed harness executable, or another release
of the same install that an auto-update left running: the paths differ only in
one version-named directory or file with the same suffix
(`…/releases/0.160.0-aarch64-apple-darwin/bin/codex` beside `0.160.1-…`).
Anything else, such as a different build suffix, install root or file name,
still refuses. A seat on an older release keeps fleet tools and peer messaging.
Its roster and doctor `workerTools` entry shows `harnessUpdate` (`running`,
`installed`, `observedAt`) and a remediation from its last process proof. Resume
the same thread when it is idle to run the current release.

## Windows fleets

A configured Windows fleet uses a service-owned SSH relay to admit its live
stream and pane for connected tools. Legacy fleet bearers also admit tools,
without proving a pane or mailbox. Loss of the fleet connection denies tools.
Native project, hire and mailbox proof still observes process lifetime, ancestry,
installed executable and actual cwd. Register project workspaces with the fleet's
own machine ID; two fleets' IDs never substitute for one another. Native proof does
not gate tools once transport admission succeeds.
See [the trust contract](../../../../docs/remote-process-proof.md). A host observer
or isolated relay smoke test does not establish that a real pane sees its native
catalog; only an owner-run pane check does.

For repeated Claude catalog-report warnings, compare the selected native plugin
cache with the prepared marketplace, including the worker version and helper
bytes. Changed source under the same version can leave the old native cache in
place. Ship a new worker version and use the approved `clankie herdr prepare
FLEET_ID` setup path; then check an owned native pane. An already-running process
can still have its old mod imported. Coordinate save/restart/resume with that
pane's owner rather than steering another lead's session.

Service-created Windows Codex hires bind their dedicated server's original OS
lifetime to one live native pane/thread. They require the exact worker bridge
shipped with the service; a stale, redirected or changed installation refuses
before the first brief. The owner can update it with `clankie herdr prepare
FLEET_ID`. Hiring does not rewrite the remote profile. The first brief waits for
`clankie_tools` and `clankie_call` while fleet tools are on (neither while off),
plus `message_clankie`. Changed native project/admission state still prevents hire
dispatch; account checks apply when a provider tool is called. An unbound server
confers no native hire or mailbox authority. An uncertain hire is not permission to retry or type into its pane.

Windows Codex can be installed even when Node cannot execute its `.cmd` shim.
Doctor resolves only a unique installed native executable from PATH or fixed npm
layouts and reads its native MCP configuration. A legacy Node Clankie bridge
with both Herdr environment variables is a registration, not a missing-plugin
repair instruction. Config inspection never proves the agent's live socket or
tool acceptance; preserve dotfiles-generated config and use its owning setup.
