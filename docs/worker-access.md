# Shared connected accounts

Admitted fleet panes receive standing access to every connected MCP server whose
account is verified. Provider credentials stay in Clankie's broker. The bridge
exposes `clankie_tools` and `clankie_call` for connected accounts. The native
worker bridge separately supplies `message_clankie` and, with stronger native
identity proof, `list_fleet_seats` and `message_peer`. Manual grants keep their selected direct tools.
[ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md) supersedes the
project-tool gate in ADR 0216. Projects still own roles, caps, hiring and tracker binding.

Worker reports use the service's persisted hiring or adopting conversation,
including fleet-qualified remote seats. `message_seat` from another admitted
conversation adopts the worker under that lead. `message_clankie` cannot choose
a target or turn agent output into an owner instruction. A removed lead makes
reports fall back to `global-default`; a retained room still requires its current
actor and route grants. Existing receipt IDs prevent rerouting or replaying an
already accepted report.

Load the shipped `clankie` skill to discover the current catalog, verify the
connected actor, read the issue and decisions, and perform the authorized change.
Tool access does not authorize every outward action. `linear-issues` carries the
read-before-write and editing rules.

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

No native session, harness executable, PID lifetime, canonical cwd or project grant
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
this is not limited to operations already dispatched. No global concurrent-call
or time bound has been proven. This is the chosen contract (VUH-1585,
[ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md)): the switch stops new
calls rather than promising atomic revocation. The original strict guarantee was
not met and was replaced by this decision, not shown to pass. An operation already
dispatched to a provider cannot be recalled.

## Messages between workers

Workers can message another current seat in their own fleet without asking
Clankie to relay each exchange. The Claude worker plugin and `clankie mcp --fleet`
share the `runSeatChannel` bridge and expose:

- `list_fleet_seats({})`: the sender's own fleet, with its identity and exact
  recipient seat/binding records.
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
the message. While unresolved, another `message_peer` call reads only the
original receipt. Once that receipt is settled, a different recipient or follow-up
remains unsent; invoke again deliberately if that new message is still needed.
If the original recipient closes or loses its native binding, reconciliation
terminates as `recipient_gone` with an `unconfirmed` outcome. Delivery remains
unknown; the original is never resent, and the sender can send a fresh message.
The service retains full bodies for the latest 100 settled messages and every
unresolved message. Older settled bodies are pruned, with compact exact receipts
retained to prevent an old delivery ID from dispatching again.
[ADR 0213](adr/0213-clankie-retires-swarm.md#direct-peer-messages-vuh-1608)
records this contract.

## Discover and call

`clankie_tools({query?: string, names?: string[]})` searches the current permitted
catalog. A query returns at most 20 qualified names with one-line descriptions.
An omitted query returns the first bounded page. `names` selects at most 10 full
input schemas, with descriptions; unavailable names are omitted. It never emits
an unbounded catalog grouped by server. Discover the schema before dispatch:

```json
{ "query": "linear get issue" }
{ "names": ["linear_get_issue"] }
```

Call the discovered name through `clankie_call({name, arguments})`:

```json
{ "name": "linear_get_issue", "arguments": { "id": "VUH-1558", "includeRelations": true } }
```

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
pane settles, including stalled HTTP requests. A persistent connected-tool
failure retains the separately available worker tools. Later lists and calls check current access; discovery never
retries a mutation. Codex can retain its startup catalog despite tool-list-change
notifications, so the owner may need to reconnect MCP or restart a pane after
cutover. A displayed stale tool never bypasses current service authorization.

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
bridge/catalog or demonstrated a call. Live PC acceptance is a separate native
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
- Provider permissions still apply. Launch isolation is not an OS sandbox;
  direct access to an operator bearer or the owner's broker provides other authority.
  Keep credentials out of transcripts and use the
  [tracker identity contract](worker-tracker-identity.md) and
  [Linear worker publishing](linear-worker-posts.md) for attribution.

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
