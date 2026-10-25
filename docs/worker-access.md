# Shared connected accounts

Admitted fleet panes receive standing access to every connected MCP server whose
account is verified. Provider credentials stay in Clankie's broker. The bridge
exposes `clankie_tools` and `clankie_call` from fleet settings and admission;
provider discovery and verified account checks happen on invocation. The native
worker bridge separately supplies `message_clankie` and, when peer messages are
enabled, `list_fleet_seats` and `message_peer`, and the landing review tools
(`submit_for_review`, `review_candidate`, `review_verdict`; see
[Landing review](#landing-review)). Peer and review invocations require stronger
native identity proof. Manual grants keep their selected direct tools.
[ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md) supersedes the
project-tool gate in ADR 0216. Projects still own roles, caps, hiring and tracker binding.

Worker reports use the service's persisted hiring or adopting conversation,
including fleet-qualified remote seats. Many leads run at once, so a hire
belongs to the conversation that hired it. Another lead may still message it:
`message_seat` (including a question answer) delivers, the result names the
`ownerConversationId`, and the hire keeps its lead, so its reports and
completion wakes still go there. Only that lead may close it:
`close_worker_pane` from another conversation is refused with `not_owner`
naming the owner. A hire whose lead conversation no longer exists, and a
hand-started seat Clankie did not hire, are adopted by the conversation that
messages them. The roster (`op: "roster"`, seat `owner`) and `clankie herdr agent
list` (`owner`, `hired`, and `mine` when `CLANKIE_CONVERSATION_ID` is set) show
each worker's lead, or `unowned`. `message_clankie` cannot choose
a target or turn agent output into an owner instruction. A removed lead makes
reports fall back to `global-default`; a retained room still requires its current
actor and route grants. Existing receipt IDs prevent rerouting or replaying an
already accepted report.

When a native seat drives that lead conversation, `message_clankie` reports
arrive as `kind="message"`, framed as untrusted agent output. Completion harvests
retain `kind="watch"`, and self-wakes retain `kind="wake"`. The message tag
grants no owner authority and changes neither the retained lead route nor receipt
semantics. Room-owned reports still use the existing correlated native reply
and original actor, route and mouth checks.

Load the shipped `clankie` skill to discover the current catalog, verify the
connected actor, read the issue and decisions, and perform the authorized change.
Tool access does not authorize every outward action. `work-items` carries the
read-before-write and editing rules.
An outward Discord post or a message into someone else's Clankie thread needs
the owner's go-ahead for its content and destination. If that scope is missing,
present the exact draft and destination and ask before sending; read-only
inspection does not grant posting authority.

## Work repositories

Register the work repo as its own project and set owner overrides for `push`
and `release`, plus `closure` if wanted ([project settings](cli.md#project-list-project-settings-and-project-update)).
These are working preferences carried in briefs, not a forge permission system.
Work boundaries live in three places:

- Workers and the operator seat use their native harness permission system
  (Claude Code or Codex); keep the work forge credentials in that harness's
  approved account context, outside Clankie's connected accounts. Choose those
  harnesses when native approval prompts are required; a Pi worker supplies no
  such prompts.
- The forge protects the default branch and requires merge-request approval.
  Enforce protected-branch writes there, including direct pushes and bypass
  permissions; a brief saying “never push to main” is not enforcement.
- Clankie's pi runtime uses lane grants and has no native permission prompts.
  An unseated operator turn, including Linear wakes, Auto rounds and self-wakes,
  can use its granted shell and connected accounts without a per-action prompt.

Under [ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md), any admitted
fleet member can use a verified connected account; a work-project override does
not restrict that account to its project. Harness account context is not an OS
sandbox against another same-user shell ([VUH-1687](https://linear.app/vuhlp/issue/VUH-1687)).
Before using a work project, the owner must choose whether to accept pi's lane
grants or route its operator turns through the native seat; do not infer that
choice from `push: owner`. A per-action pi envelope remains a separate
[VUH-1523](https://linear.app/vuhlp/issue/VUH-1523) decision. Apply the work repo's
preferences to that project, without imposing a global work preset on Discord,
voice, play or other projects.

## Windows Claude channels after an update or deploy

The linked Claude bridge follows a republished fleet link after a runtime restart.
Its next admitted mailbox poll binds the new runtime's mailbox; readopting the
seat does not establish a live channel. Connected tools and native message
delivery have separate admission checks, so working Linear calls alone do not
prove that the channel or reports work.

A pending Claude Code update can rename the loaded image to
`claude.exe.old.<timestamp>.<updater-pid>`. Several workers may share that image:
the suffix is the updater's PID, not necessarily the worker's. The Windows probe
accepts only the independently installed launcher's exact predecessor renamed
during the worker's lifetime, with fresh native process, pane ancestry and socket
ownership proof. It does not require a worker restart to recognize that image.

For a released channel, inspect retained receipts and the native proof before
reconnecting a busy session. A server-side recognition fix applies to a running
bridge that is still retrying when the corrected runtime is deployed. Verify
its recovery after the scheduled deploy. If polling has stopped permanently,
wait for the worker's turn to end, then coordinate an MCP reconnect with the
owner; preserve the session, cwd, account profile and channel launch flag if
resume is needed. Never replay an uncertain original as a new message.

## Catalog changes in Codex

The fleet bridge lists its catalog when it changes and emits MCP
`notifications/tools/list_changed` for added, removed or changed definitions.
A seat's mailbox long poll carries its catalog revision, and the service ends a
parked poll when a refresh request, a deploy or the fleet tool and peer settings
change it, so the bridge lists only then (VUH-2062). A bridge without the seat
channel, such as every Codex seat, long-polls
`GET /v1/fleet/seats/{paneId}/tool-catalog?wait=25000&revision=R` for the same
revision instead; that wait never reads or binds the mailbox (VUH-2390). An
unchanged catalog is still checked every five minutes. A bridge without a fresh
revision (a failing poll, or a service without the wait, which answers 404)
checks every five seconds and tries the wait again after five minutes; bridges
before worker 0.6.19 keep their five-second check without a channel.
While a seat is mid-turn (any Herdr status but idle or done) the service holds a
changed catalog, and the bridge keeps its published one until the turn settles,
checking every five seconds only while such a change waits. An unchanged
catalog is never held.
Temporary discovery failures, including admission refusals, keep the previously
verified schemas. Explicit settings metadata removes disabled tools. Calls still
pass through Clankie's current admission and account checks, and a refusal reports
the service's reason. A notification never replays a tool call.

Codex 0.160.0 logs this notification without updating its executable catalog.
Plain `config/mcpServer/reload` also reuses an unchanged ready connection.
For locally hired seats with a dedicated app-server and copied worker config,
Clankie's controller atomically persists the proven bridge registration, tool
approval and connection environment revision through `config/batchWrite`, then reloads.
Hires since VUH-2390 register the bridge as `node` running this install's
`integrations/claude-plugin/worker/bin/fleet-mcp.mjs`, with no `clankie mcp --fleet`
wrapper process; the refresh also accepts the wrapper for seats launched before
and preserves whichever registration the seat was proven with. Codex reconnects Clankie's MCP connection
at the next model step on the same thread. The pane, conversation and message
tool remain available. Refreshes are serialized and failed RPCs are retried at
most three times per catalog change; no tool call or turn is retried.

This workaround does not rewrite the owner's config, apply to manually started
clients, or refresh remote seats. For those clients, first check admission and
`fleet.tools`, then ask the owner to reconnect. Preserve the exact thread UUID,
cwd, account home and launch flags. A shared daemon can keep an unloaded pane's
thread cached: wait until that exact thread is no longer loaded before resuming
it. Never restart a shared daemon or fork the conversation automatically.
Controller-owned hires need controller recovery rather than a second manual
process attached to their thread. A fresh status-list connection is not proof
that an existing thread can call the tool.

## Fleet admission and the kill switch

The existing transport admission is the proof:

- Local panes use `LocalFleetLink`: the separate loopback listener proves the
  socket belongs to the pinned Herdr session and pane. Discovery has no bearer.
- Remote relay streams use the service-owned `FleetLinks.fetch` admission. The
  current stream and registered fleet connection must remain live.
- A remote fleet bearer link admits that fleet's tools without proving a pane.
  Its audit principal records `pane:unverified`; the session key belongs to the fleet.
  The link does not establish a native project assignment, grant mailbox access
  or permit peer messages.

On macOS, local admission uses a bounded native `libproc` census, rather than
`lsof` socket scans. It observes the unique client endpoint owner, its process
birth and socket identity. Non-owner ancestor lifetimes come from kernel
`sysctl` process records across users, so Terminal's root `login` ancestor does
not block a legitimate pane. The owner still requires full same-user process
observation. Two fresh observations
bracket the live pane and linked-session checks. That full proof runs once per
connection: later requests on the same live socket reuse it while the owner and
its lineage up to the pane shell keep their kernel births, Herdr reports the same
shell for the pane, the binding is unchanged and any private seat is still
registered. Any failed recheck runs the full proof again. Shared ownership seen
by a full proof, missing observations, exit, PID reuse and revoked bindings fail
closed. A descriptor handed to another process after its connection was proven is
not seen until that connection is proven again
([details](../integrations/fleet-proof/README.md#proof-once-per-connection)). Service-owned private app-server
registrations retain their separate live checks. See the
[native helper](../integrations/fleet-proof/README.md) for build and verification.

After a service restart, Codex roster status reads live thread metadata and its
native waiting flags. It does not reload historical tool output on each poll;
explicit question reads and answers still validate their current native items.

The body owns one persistent native helper over private pipes. Every job still
checks fresh kernel facts; the helper itself retains no admission. Herdr foreground and session reads use its socket API directly.
No helper, Herdr CLI or `ps` process is launched for ordinary mailbox/catalog
polls or restored-private-seat birth checks. The bounded queue starts each 1 s
timeout when the job becomes active. Cancelling one caller removes its queued
job or drains and discards its active reply; other callers keep their proofs.
Queue depth stays at 128; waiting under a burst can exceed 1 s, and queued
callers can abort.
The worker request's deadline follows local admission through Herdr reads,
socket census and project observations. Expired requests remove their queued
helper work; an active helper reply still drains before another job uses the pipe.
Cancellation is a request failure, not evidence that the pane lost membership.
An active timeout, malformed reply or helper exit refuses pending observations,
and the body closes its own helper
at shutdown. Refusals emit `fleet.local_proof.refused` with a fixed reason;
`fleet.local_proof.diagnostic` records fixed kernel or transport details.
Neither event contains PIDs, paths, argv or caller headers. The helper reconciles
changing PID lists by inspecting their bounded union.
Unrelated transient PID/descriptor races repeat only the affected process observation,
with its partial owner discarded. These local retries use 1–8 ms jitter and at
most 32 attempts per PID within the unchanged 200 ms scan and 600 ms job caps.
An expired scan, or instability after observing a matching socket, restarts the
entire bounded census to inspect newly born inheritors. Unknown live ownership,
owner/ancestor changes and shared descriptors remain refused; persistent
uncertainty or exceeded bounds can still refuse admission.

When project identity is required, the same helper reads the foreground agent's
executable, exact first launcher arguments, and the shell and agent's microsecond
births. These observations bracket current native-session and foreground-pane
checks. Socket ancestry must agree with the observed process lifetime, including
microseconds. There is no foreground `ps`/`lsof` fallback, and project identity
is never bound to a connection. Generic hire receipts recorded with older display timestamps
fail closed until a fresh hire records the complete kernel lifetime.

Local admission can refuse when process or descriptor ownership changes during
the census. The native helper repeats the affected process observation for
descriptor churn; it never skips an uncertain live same-user record. When current
proof is unavailable, HTTP 503 `fleet_admission_unavailable` marks the request
retryable: nothing was forwarded. Claude and Codex bridges wait briefly and retry
that refused request once. If proof remains unavailable, the reply says to retry
shortly, then ask the lead to inspect admission if it persists. This does not mean
the seat needs a new fleet admission. A definite non-member gets HTTP 403
`local_process_membership_required`, with guidance to ask the lead for admission;
the bridge does not retry it. Automatic polling and catalog refresh go quiet
on that exact refusal instead of flooding the service. Worker startup hooks
also check Herdr's pane presence: an exact `pane_not_found` leaves the worker
unclaimed, including a pre-warmed spare that inherited an obsolete pane ID.
Unavailable observations remain unknown and still require server proof.

Only an explicit pre-forward refusal permits that retry. A timeout, lost reply or
uncertain receipt remains uncertain: reconcile the original receipt, even if a
later request receives an admission refusal. A later refusal does not prove that
an earlier call had no effect.

No additional native session, harness executable, canonical cwd or project grant
is needed for connected tools after fleet admission. Anything running in an admitted pane,
and anyone holding a valid remote fleet bearer, can use the verified connected
accounts, including ordinary Linear writes as Clankie. This is the owner's accepted
trust boundary; project approval does not narrow it.

`fleet.tools` defaults to `connected`. The owner can stop new standing tool
admissions:

```sh
clankie fleet status
clankie fleet set --tools off
clankie fleet set --tools connected
```

The console's `/fleet` editor exposes the same setting. `off` lists no standing
fleet tools and refuses new standing admissions, including calls from a stale
catalog. It does not revoke manual grants. Disconnecting a fleet removes its
admission. Calls recheck admission, account binding and settings; the MCP host
also fences account and server configuration.

These checks do not provide atomic revocation. A call already past its last
asynchronous check can still reach the provider after tools-off or lost admission;
this is not limited to operations already dispatched. Worker requests have a
thirty-second total deadline; six concurrent native-first hires and issue reads
are covered against an isolated tracker. Those bounds do not make revocation
atomic. This is the chosen contract (VUH-1585,
[ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md)): the switch stops new
calls rather than promising atomic revocation. The original strict guarantee was
not met and was replaced by this decision, not shown to pass. An operation already
dispatched to a provider cannot be recalled.

Connected-account reads do not acquire native publication attribution. A write
may obtain that optional author/recipient proof within one shared budget of at
most two seconds, further limited by the request's remaining time. Missing or
expired attribution cannot remove an independently admitted account grant or
invent an author. Publication tools that require a proven author still refuse
without it. Exact tool invocation and receipt lookup verify only their selected
connected account; broad catalog discovery still checks each offered account.

## Messages between workers

Workers can message another current seat in their own fleet without asking
Clankie to relay each exchange. The Claude worker plugin and `clankie mcp --fleet`
share the `runSeatChannel` bridge and expose:

- `list_fleet_seats({})`: the sender's own fleet, with its identity and exact
  recipient seat/binding records. A seat on a remote machine sees the other seats
  on that machine; the service reads the sender's fleet inventory, not only this
  Mac's.
- `message_peer({seat, text})`: set `seat` to a returned `seatId` and provide the
  message text. The bridge obtains the sender and recipient bindings; workers
  do not supply them. A current binding does not authorize a later pane occupant.

The service enforces this authority on local and remote paths. The sender must
have a proven native pane process and a matching native session. Transport-only
fleet admission, caller-supplied pane IDs and legacy bearer-only links cannot
establish that identity. Connected-tool access and project approval do not widen
peer-message scope. The recipient must belong to the same fleet, retain the exact
current binding and have an available native delivery route. A changed occupant
or session requires fresh discovery, not redirecting the old message.

Discovery uses `GET /v1/fleet/seats/{paneId}/peers`, sending uses
`POST /v1/fleet/seats/{paneId}/peer-messages`, and reconciliation reads
`GET /v1/fleet/seats/{paneId}/peer-messages/{id}`. The server derives the sender
from admitted process/session proof and scopes receipt reads to that sender.
On the local listener, that proof already checks the unique socket owner,
process lifetimes, ancestry, native pane/session and private registration. Peer
routes consume it directly and reobserve it at later authority checks, rather
than repeat broad fleet admission around every native check. Discovery brackets
its roster reads with fresh proofs; sending and reconciliation retain their
separate native sender/recipient fences. Project proofs are never reused between requests.
Delivery reuses `message_seat` and its native harness channel/session API,
receipts and refusal states; it never types terminal keys or revives Swarm.

Messages are framed as agent output from the verified sender, never owner
instructions or new authority. Each send records server audit provenance and an
agent-role entry in Clankie's default transcript; native channel events carry `source: peer`. This happens without waking
him or creating an owner turn. The receiving
worker and Clankie still act within their existing assignment and permissions.

`fleet.peerMessages` defaults to `on`. Only the owner or an authorized operator
changes it through the CLI or the `/fleet` editor:

```sh
clankie fleet status
clankie fleet set --peer-messages off
clankie fleet set --peer-messages on
```

`off` hides both peer tools and refuses new sends server-side, including calls
from stale catalogs. It is independent of `fleet.tools`: either capability can
be disabled while the other remains enabled. Existing receipt reads and native
receipt reconciliation remain allowed with peer messages off. A message already
dispatched cannot be recalled.

After an uncertain send, retain and reconcile the original peer receipt and its
original native delivery receipt. Never POST the same intent again, delete its
receipt state or switch bridges to compensate for missing acknowledgment. An
unknown result is a gap to report, not proof of failure. A successful native
delivery receipt proves the stated handoff, not that the model read or accepted
the message. While unresolved, another `message_peer` call to the same seat reads
only the original receipt; messages to other seats are sent normally. Once that
receipt is settled, a different follow-up remains unsent; invoke again
deliberately if that new message is still needed. An original that nothing proves
or rules out within 15 minutes settles as `superseded` with an `unconfirmed`
outcome: it is never resent, and a different message to that seat goes out as a
new message labelled as following it.
If the original recipient closes or loses its native binding, reconciliation
terminates as `recipient_gone` with an `unconfirmed` outcome. Delivery remains
unknown; the original is never resent, and the sender can send a fresh message.
The service retains full bodies for the latest 100 settled messages and every
unresolved message. Older settled bodies are pruned, with compact exact receipts
retained to prevent an old delivery ID from dispatching again.
[ADR 0213](adr/0213-clankie-retires-swarm.md#direct-peer-messages-vuh-1608)
records this contract. Peers never cross a fleet boundary: a seat on one machine
cannot message a seat on another, and the send is refused as unknown or ambiguous
in this fleet. Until [ADR 0287](adr/0287-a-standing-reviewer-gates-every-landing.md),
remote seats also saw an empty catalog; that is fixed.

## Landing review

When a project names a standing reviewer
([ADR 0287](adr/0287-a-standing-reviewer-gates-every-landing.md)), the worker
bridge adds three tools. The service advertises them with `reviews: "on"` in its
catalog metadata, so an older service shows none.

- `submit_for_review({checkout, summary, issue?, evidence?, base?})`: the author
  sends the exact committed change (`git diff --binary` from the merge base with
  `origin/main` to `HEAD`) of the absolute `checkout` it names. The bridge resolves
  that path to its work-tree root and never reads its own working directory, which
  is where the session started (VUH-2662). A missing, relative or non-git checkout
  is refused with nothing stored, and every result echoes the `read` checkout,
  `HEAD`, base and patch-id. A seat without the tool (a harness that lacks the
  review tools, or a bridge started before them) runs `clankie review submit`
  in its own pane, proven by the same fleet link. The service hashes it, routes it to a live reviewer
  seat other than the author and returns the candidate. Passing the same `issue`
  after CHANGES links the new candidate to the old one.
- `review_candidate({candidateId})`: the author and the project's reviewer read
  the stored patch and the candidate record.
- `review_verdict({candidateId, patchId, verdict, findings?, summary?})`: the
  reviewer records `approve` or `changes` for the patch it read. CHANGES needs at
  least one concrete finding. A verdict is refused from the author, from a seat
  that is not the project's reviewer, and for a different patch-id.

These use the same native seat proof as peer messages, never a caller-supplied
identity, so transport-only admission and bearer links cannot submit or decide.
They do not depend on `fleet.peerMessages`. Seat routes are
`POST /v1/fleet/seats/{paneId}/review-candidates`,
`GET /v1/fleet/seats/{paneId}/review-candidates/{id}` and
`POST /v1/fleet/seats/{paneId}/review-verdicts`; the owner reads with
[`clankie review`](cli.md#review).

## Discover and call

`clankie_tools({query?: string, names?: string[]})` searches the current permitted
catalog. A query returns at most 20 qualified names with one-line descriptions.
An omitted query returns the first bounded page. `names` selects at most 10 full
input schemas, with descriptions; unavailable names are omitted. It never emits
an unbounded catalog grouped by server. Its own description names the servers
connected right now (`Connected now: linear`), and the worker plugin's standing
instructions point at it, so a harness that loads it as a deferred tool still knows
Linear and the other connected accounts are reachable. Discover the schema before dispatch:

```json
{ "query": "linear get issue" }
{ "names": ["linear_get_issue"] }
```

Call the discovered name through `clankie_call({name, arguments})`:

```json
{ "name": "linear_get_issue", "arguments": { "id": "VUH-1558", "includeRelations": true } }
```

A `linear_*` tracker call without `repo` follows the caller's hire
(VUH-2014). A worker hired for a registered project uses that project's saved
convention. On a `builtin` project (one cut over from Linear), or any other
non-Linear convention, the call goes to the project's own tracker, so the
built-in store records the write as the worker. The tracker scope refuses writes
outside the project, and `linear_graphql` is refused. On a `linear` project the
call reaches Linear as before. A project with no tracker binding counts as
`linear` when its local workspaces' saved conventions are all `linear`. A project with no saved convention, one that is
gone, or one whose tracker cannot be read here refuses the call. Pass `repo` to
name another tracker; an explicit `repo` always wins. A bearer-linked worker
without a verified pane, or a pane that is not a confirmed project hire, keeps the old
routing.

Unverified or unavailable accounts contribute no upstream tools; one failing
server does not remove the others. Fleet discovery still lists the two bridge
tools when no account verifies, but searches return no upstream names and calls
are refused. Linear worker-publishing tools (`create_worker_comment` and
`create_worker_issue`) are excluded: they require an exact `personaId` grant.
Ordinary connected tools use the shared rule matcher, argument checks and
`host.call` delegation path. Each provider call records fleet and pane provenance.

Codex hire readiness expects the two meta names while fleet tools are on, and
no connected-tool names while off, regardless of project grants. The worker
plugin's `message_clankie` is a separate expectation; authorized peer tools are a
separate native capability. This check does not create
a grant or prove a native provider call.

## Verify the account

`/connect linear` verifies an API key using stable user/workspace IDs, email and
workspace name. For an existing API key or OAuth connection, run
`clankie access linear verify`; `clankie access linear` and `/access linear`
show the recorded identity. Confirm the intended actor and destination before
writing. No email is a product default.

OAuth verification calls `get_user` with `query: "me"` and `get_workspace` at
Linear's official MCP endpoint using one locked credential snapshot. MCP-audience
tokens never go to GraphQL. Reverification preserves manual account binding when
stable user/workspace identity is unchanged; a changed identity invalidates those
grants. Standing fleet authority uses the current verified account on the next
request. Account changes during a call refuse that call. Verification does not
sign in as a different user.

## Manual grants

Discover the real tool names and schemas with Clankie's tool search. A request
selects `principalId`, `workId`, `server`, tools and a lifetime of at most 900
seconds. Tool argument restrictions are exact top-level comparisons:

```json
{
  "principalId": "reviewer",
  "workId": "issue-identifier",
  "server": "linear",
  "tools": [
    {
      "name": "save_comment",
      "arguments": { "issueId": "issue-identifier" },
      "forbiddenArguments": [
        "id",
        "parentId",
        "projectId",
        "initiativeId",
        "documentId",
        "milestoneId",
        "statusUpdateId",
        "statusUpdateType"
      ]
    }
  ],
  "ttlSeconds": 900
}
```

```sh
clankie access issue request.json --out worker-grant.json
clankie access list
clankie access revoke GRANT_ID
clankie mcp --grant /private/path/worker-grant.json
```

Issuance needs operator authentication. `--out` writes a new private file (0600)
and prints metadata, never the bearer. A failed file delivery attempts to revoke
that grant and reports unconfirmed revocation. Deliver only the private file to
the intended worker through an authorized channel. The bridge exposes granted
tools, with no operator credentials or seat channel. Its endpoint must use HTTPS
or loopback HTTP. Tokens expire and require explicit reissue; task-bound renewal
and coordinator-based delivery are retired by [ADR 0213](adr/0213-clankie-retires-swarm.md).
Saved task-bound or renewable grants remain on disk and confer no authority.

Revoking a manual grant closes every MCP session using it, aborting pending
requests. The host checks that request's abort signal at its final dispatch
boundary, after awaited setup, so a completed revoke prevents a call that has
not yet dispatched even if its earlier grant read succeeded. Revocation cannot
undo an effect already dispatched to the provider.

## Projects and retained grant records

Projects retain approved workspaces, explicit native hire assignments, roles,
worker limits and tracker binding. Use `clankie project add` and the project
settings API for those policies; do not expand workspace approvals to fix a missing
tool catalog. Native project and mailbox proof remains separate from fleet tools.

`clankie access project NAME SERVER [--tool NAME]...` remains available for inspecting
and maintaining legacy project-grant records. Those records no longer determine
fleet tool access. They produce no bearer; revoking one does not remove standing
fleet tools. The owner disables fleet access with `fleet set --tools off` or
removes the fleet connection. Retired fleet-grant records remain readable and
explicitly revocable, without copying, migration or automatic revocation.
`clankie access fleet` continues to refuse issuance.

## Native discovery and diagnostics

Register `clankie mcp --fleet` in Codex with `env_vars = ["HERDR_PANE_ID",
"HERDR_SOCKET_PATH"]`, or use the shipped Claude worker plugin. Preserve
source-managed/symlinked harness configuration. The existing PC Node bridge
proxies list/call and needs no new wire protocol for the two-tool catalog.

The bridge retries initial discovery with backoff for up to 20 seconds while a
pane settles, including stalled HTTP requests. An unproved initial catalog fails
with its real reason; hired Claude and Codex panes wait for the expected wrapper
and enabled peer tools before their brief. Verified catalogs remain present
through temporary failures. Lists and calls use bounded initialization and body
reads, with a thirty-second total request budget. Replacing a service provider
connection preserves already dispatched calls until they settle. Discovery never
retries an uncertain mutation. Codex can retain its startup catalog despite tool-list-change
notifications, so the owner may need to reconnect MCP or restart a pane after
cutover. A displayed stale tool never bypasses current service authorization.

Connected calls return typed JSON with a `receiptId`. A deadline after provider
dispatch returns `outcome: "uncertain"`: the write may have applied. Reconcile
with `clankie_call({receiptId})`, without the tool name or arguments. That lookup
reads the durable original receipt under the same authenticated worker, granted
tool and connected account; it never dispatches another provider call. Already
admitted calls retain their bounded original completion lifetime so a late
response can settle the receipt. The bridge chooses its receipt ID before
forwarding, preserving reconciliation when the HTTP response is lost.

Connected-call receipts live under `~/.clankie/worker-grants/receipts/`.
`connected-calls.json` commits a small manifest of immutable, content-addressed
buckets in `connected-calls.json.d/`. A receipt change rewrites its bucket and
the manifest, rather than the whole retained ledger. Legacy array journals
migrate on their next save. Shards are synced before the manifest is committed;
missing or changed committed shards refuse dispatch. All uncertain records and
identity tombstones survive retention; only older settled response bodies and
optional recovery detail are trimmed. Never delete these files to retry a call.

Inbound message claims remain exclusive through timeouts and lost accepted
responses. A definitely refused connection before POST delivery releases only
the matching claim. An exact authenticated unknown-delivery response releases
it only after persisting a terminal ID fence against a delayed original POST.
For an exact pending pane delivery without conversation acceptance, lookup can
settle absence after service replacement or the host's 20-second request deadline.
The service records the attempt owner and deadline, seals its ID and clears only
its matching pane fence in one write. Live same-instance requests remain unresolved;
expired, cancelled or shutdown requests cannot subsequently accept the message.
Accepted history remains authoritative, and corrupt or mismatched evidence stays
uncertain. Replacement recovery relies on the service's exclusive process lock.
After shutdown the old instance cannot write receipt fences. If an accepted
original still needs pane cleanup, it retains uncertainty until the replacement's
exact lookup clears that pane, keeping the worker's next message from getting stuck.
The current invocation never sends a replacement; a subsequent invocation can
send a new message. Authentication failures expose a generic refusal, while
authenticated downstream failures retain their actual reason.

Local hired Codex servers outlive a service restart. Their completed launch
registrations persist in `local-codex-seats.json` under `CLANKIE_STATE` (default
`~/.clankie`), independently of the pinned code checkout. After restart, each
request still checks the original server PID/start time, the selected Herdr
socket/session and the current native foreground occupant, so `message_clankie`
keeps working without transferring an old worker's identity to a replacement.
An unreadable record file never blocks startup: it is moved aside and no seat is
restored. Hires created before these records existed cannot recover; report
through the lead's watch. The outbound Codex adapter's turn state stays in memory.

Fleet membership doctor reports project eligibility and native observations.
`eligibility: unsupported` or missing project proof does not deny fleet tools.
`nativeTools: not-verified` means the diagnostic has not inspected that pane's
bridge/catalog or demonstrated a call. Doctor and the roster distinguish bridge
transport presence from `freshness: older-than-runtime`: the observed bridge
started before the running service, so the seat needs reloading. This is a reload
hint, including after a same-build service restart, not proof of an obsolete
build or successful delivery. Missing start-time facts remain `unknown`.
The separate `workerTools` field records served/reported catalogs, missing tools
and stalled calls with their real reason. A new authenticated bridge process
starts a new observation cohort; late reports cannot overwrite it. Cached schemas
and diagnostic observations grant no authority. `No durable native binding` on
a message receipt means no new message was sent; inspect the native binding.
Operator bridge presence does not prove worker bridge readiness; reconcile an
uncertain original receipt before another attempt. Live PC acceptance is a separate native
check after landing and re-pin: two connected bridge tools plus `message_clankie`,
and a Linear issue read through `clankie_call`. Deterministic fixtures do not
establish that acceptance.

VUH-1608's live peer-message acceptance is a separate check with two actual KH2
panes on the PC after landing and re-pin. It must establish discovery, native
delivery, authority framing, the owner off switch and honest receipts in those
panes. Deterministic server and bridge regressions do not establish that live result.

## Boundaries and limits

- Manual grants keep exact top-level `arguments` equality, `forbiddenArguments`,
  maximum 900-second expiry, durable revocation and account binding. Omitted
  arguments remain unrestricted. `workId` is provenance, not issue isolation.
- Manual sessions belong to one grant. Admitted pane sessions belong to fleet and
  pane; bearer sessions belong to fleet with no verified pane. Idle sessions
  expire after 15 minutes; clients reconnect after a service restart.
- Worker publishing stays behind an exact manual `personaId` restriction.
  Fleet tool access does not invent a persona or grant worker attribution.
- Provider permissions still apply. Ordinary launch isolation is not an OS sandbox;
  direct access to an operator bearer or the owner's broker provides other authority.
  Keep credentials out of transcripts and use the
  [tracker identity contract](worker-tracker-identity.md) and
  [Linear worker publishing](linear-worker-posts.md) for attribution.
- An explicitly prepared installed macOS runtime can confine service and native
  descendants with an OS profile ([ADR 0257](adr/0257-a-lowered-local-runtime-keeps-an-os-boundary.md)).
  It does not separate worker authority from service credentials inside its
  private home or from a provided service bearer. Live activation remains owner-held;
  do not infer confinement from a lower access preference or launch marker.

### Retirement issue bookkeeping

Pane retirement and issue settlement have separate receipts. The keeper captures
an exact confirmed native hire while its roster occupant is still proven. A normal
complete-inventory exit can mark that hire gone before bookkeeping; replacement
allocations and recovery release invalidate the captured attribution. Each effect
resolves the project's current saved tracker, preserves the originally observed
issue UUID, and applies the existing project and account fences. A display key
such as `LOCAL-VUH-4` cannot become `VUH-4`, and identical keys in different stores
cannot exchange successors, pause records or write targets.

Unavailable, revoked or ambiguous project bindings refuse issue effects. Saved
Linear routes retain their connected resource and scope, including legacy projects
with one unambiguous saved Linear convention. Disconnection never chooses the
adapter's local compatibility store. Built-in Done still requires the owner's
verification; retirement evidence grants no human identity or delivery rollback.

The daily check counts only attributable tracker ownership. Unscoped operator-head
and native-child claims are excluded rather than assigned to the default connector.
A historical pause ledger without scope cannot establish restoration authority.
Source-checkout disposable-store proof is retained under
[`docs/testing/2026-10-12-local-vuh-8`](testing/2026-10-12-local-vuh-8/README.md).
Actual installed-pane behavior requires a separate check after deployment.

### Retiring and approving machine-specific workspaces

A missing, inaccessible or noncanonical registered local workspace matches no
agents. It does not prevent valid unrelated workspaces or projects from resolving.
Remove an exact registration explicitly, even after deleting its folder:

```sh
clankie project remove-workspace kh2 --workspace /absolute/canonical/retired-worktree
```

The project, roles, caps, grants, assignments and unrelated settings remain.
A workspace referenced by the project tracker cannot be removed until that binding
is moved or removed. No directory is deleted by this command.

Remote approvals name the registered fleet machine and target path platform:

```sh
clankie project add kh2 --workspace 'C:\code\kh2' --machine pc --platform windows
clankie project remove-workspace kh2 --workspace 'C:\code\kh2' --machine pc --platform windows
```

The owner approves the exact normalized absolute spelling; the Mac does not
canonicalize a Windows path. Approval alone proves no native project membership: matching
still requires fresh native process and filesystem proof on that registered machine.

Owner API clients read `GET /v1/operator/projects` for the current settings and
revision, then call `POST /v1/operator/projects/remove-workspace` with
`projectId`, `workspaceId` and `expectedRevision`. A stale revision, tracker
reference, changed owner authority or concurrent settings edit refuses removal.

## Owner-authorized work-item gestures

Workers keep using `clankie work` for the repo’s recorded tracker. Paired devices
with `terminalControl` can assign work metadata, add or remove a role label,
and append a blocker through the narrow `work_item_write` operator operation.
This authority stays with the original owner identity through the relay;
worker or execution credentials cannot substitute for it. The CLI equivalents
are `clankie work write` and `clankie work receipt`, documented in
[the CLI guide](cli.md).

Retain the returned `requestId`. After an uncertain result, read the receipt
and tracker; never resend the change with a new ID. Receipt reads and repeated
IDs never dispatch a mutation. The journal checks owner, source item, saved
tracker and connected-account scope before returning an original result.
