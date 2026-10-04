# Shared connected accounts

Admitted fleet panes receive standing access to every connected MCP server whose
account is verified. Provider credentials stay in Clankie's broker. The bridge
exposes exactly `clankie_tools` and `clankie_call`; `message_clankie` comes from
the native worker plugin separately. Manual grants keep their selected direct tools.
[ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md) supersedes the
project-tool gate in ADR 0216. Projects still own roles, caps, hiring and tracker binding.

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
  The link does not establish a native project assignment or grant mailbox access.

No native session, harness executable, PID lifetime, canonical cwd or project grant
is needed for tools after fleet admission. Anything running in an admitted pane,
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
plugin's `message_clankie` is a separate expectation. This check does not create
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
pane settles, including stalled HTTP requests. A persistent failure returns only
`message_clankie`. Later lists and calls check current access; discovery never
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
