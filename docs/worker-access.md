# Shared connected accounts

Workers use selected MCP tools through Clankie under individual grants. Enrolled
workers authenticate with their Swarm session; other workers receive private bearers.
Provider credentials stay in his broker. Workers need a reachable Clankie
endpoint; Herdr is not required.

```mermaid
sequenceDiagram
  participant O as Operator / Clankie lead
  participant C as Clankie service
  participant W as Worker
  participant P as Connected provider
  W->>C: Connect using enrolled scope and session
  C-->>W: Empty tool list
  O->>C: Verify account, issue restricted assignment grant
  C-->>W: MCP tools/list_changed
  W->>C: List or call delegated tools
  C->>C: Authenticate scope/actor; check grant, account, task, tool and arguments
  C->>P: Call with broker-owned credential
  P-->>C: Result
  C-->>W: Result with worker provenance retained
  O->>C: Revoke grant
  C-->>W: MCP tools/list_changed
  W->>C: Further tool call
  C-->>W: Refused
```

## Verify the account

`/connect linear` verifies an API key using stable user/workspace IDs, email and
workspace name. For an existing API key or OAuth connection, run `clankie access linear verify`;
`clankie access linear` and `/access linear` show the recorded identity. Confirm
the intended automation account before delegating. No email is a product default.
The verification command addresses the built-in `linear` broker entry.

OAuth verification calls `get_user` with `query: "me"` and `get_workspace` at
Linear's official MCP endpoint using one locked credential snapshot. MCP-audience
tokens never go to GraphQL. Reverification preserves grants when the stable
user/workspace identity is unchanged; a changed identity requires new grants.
An unverified connection cannot receive worker grants. Verification identifies
the connected account; it does not sign in as a different user.

## Worker connection

New workers on Clankie's managed Herdr routes receive a `clankie_worker` MCP
server running `clankie mcp --swarm`. The launch configuration contains the
selected service URL and CLI command, with no provider or operator credential.
Swarm enrollment supplies `SWARM_SCOPE` and `SWARM_SESSION_CAPABILITY`. Current
coordinators reload route configuration for new launches. Loading new runtime
code or changing an existing worker's MCP configuration requires a deliberate
restart; the service does not restart live work.

Other enrolled runtimes can configure the same command and set
`CLANKIE_CONTROL_PLANE_URL` to a reachable Clankie endpoint. HTTPS is required
except on loopback HTTP. The service resolves the scope through its own active
connections and authenticates the capability at that known coordinator. A scope
string alone grants no authority and never selects an arbitrary network address.

The connection starts with no tools. Explicit issuance and revocation notify the
client with MCP `tools/list_changed`; the worker remains connected. Every list
and call rechecks its eligible grants, account and live task. Renewable grants
remain eligible while the enrolled session and assignment are valid; ordinary
grants retain their initial expiry. This path returns no worker token or provider
secret. A protocol heartbeat keeps an idle session active and closes the bridge
if its runtime authentication fails. It is not a model polling loop.

The owned Claude stream host renews its current, unexpired task leases every
15 seconds while the child runs, including between turns. This keeps task-bound
access valid during long tools or waits for replies. It never recovers expired
ownership or changes the attempt/fence. External hosts own their task renewal.

## Issue and deliver

Discover actual tool names and schemas using Clankie's MCP tool search. Create
a request file; this example restricts a comment tool to one issue:

```json
{
  "principalId": "swarm-worker-identifier",
  "workId": "issue-identifier",
  "server": "linear",
  "swarm": { "conversationId": "lead-conversation", "taskId": "swarm-task-identifier" },
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
  "ttlSeconds": 900,
  "renewable": true
}
```

For Swarm work, `swarm` binds access to the task's current enrolled owner. The
selected Clankie conversation must have created that task; the worker must hold
its active attempt. Each request checks the scope, actor, attempt and fence
against the coordinator. Completion, cancellation, expired ownership, a replaced
attempt or an unavailable coordinator refuses access. `workId` can still identify
the corresponding tracker issue; it is separate from the Swarm task ID.
Omit `swarm` only for explicitly operator-managed work outside Swarm.
`renewable` defaults to false and requires a Swarm binding when enabled.

```sh
clankie access issue request.json --deliver swarm
clankie access list
clankie access revoke GRANT_ID
```

Issuance requires operator authentication. `--deliver swarm` prints metadata and
`clankie mcp --swarm-grant GRANT_ID`, never a bearer. A worker already running
`--swarm` picks up the grant through its existing connection. For a client that
needs a single-grant bridge, configure the printed command instead. The non-secret grant ID can travel in an
assignment or Swarm message. Set `CLANKIE_CONTROL_PLANE_URL` to the selected
service for a remote worker; it must use HTTPS or loopback HTTP.

The bridge uses its runtime's `SWARM_SESSION_CAPABILITY`. Clankie validates that
session at the coordinator selected by the stored grant, matches actor and scope,
and rechecks the live assignment and account. The worker cannot select another
coordinator endpoint or assert its own identity. Enrollment alone issues no grant.
Wrong workers/scopes, revoked grants and ended or changed attempts receive no
token. The bridge stores its delivered token in a temporary private directory,
uses the normal renewal path and removes that directory on exit.

On restart, `--swarm-grant` authenticates the enrolled runtime again. It can
retrieve fresh tokens for renewable grants while the same assignment remains
authorized, even if the prior token expired; an expired bearer alone cannot do
this. Nonrenewable grants remain limited to their original expiry. Delivery never
creates another grant or resets revocation. This single-grant bridge is an
alternative to the built-in route's enrolled connection.

For work outside Swarm, use `clankie access issue request.json --out worker-grant.json`.
The file uses mode 0600 and never
overwrites an existing file. The command prints metadata, never the bearer.
Failed delivery attempts to revoke the grant and reports unconfirmed revocation.
`/access` in the TUI lists, verifies and revokes; issue files from the terminal.

Deliver only that private file to the intended worker through an authorized
channel. Configure its MCP client to launch `clankie mcp --grant /path/to/worker-grant.json`.
The bridge exposes granted tools only, with no operator credentials, captain
tools or seat channels. The endpoint must use HTTPS or loopback HTTP; remote
workers need a reachable HTTPS endpoint at issuance. Never place grants or
provider credentials in issue comments, Swarm messages or shared transcripts.

## Boundaries and limits

- Tokens expire after at most 900 seconds. With `renewable: true`, the worker
  bridge renews before expiry while the same Swarm assignment and account remain
  authorized. Each token retains the original lifetime and restrictions; renewal
  keeps the grant ID, so one revocation invalidates every token. Expired tokens
  cannot renew. Ordinary grants require explicit reissue.
- Renewal updates the private file atomically, preserving a symlink if supplied.
  Transient failures retry only within the current token's validity; denied
  renewal or expiry closes the bridge. A restarted bridge uses the persisted
  token. If it expires while stopped, reissue access. Give each worker its own
  grant file. The enrolled `--swarm` bridge uses runtime authentication directly
  instead of persisting a renewable token file.
- `principalId` must match the enrolled task owner when `swarm` is supplied.
  Otherwise it is an operator-assigned identity. Possession of the bearer
  authenticates a request; private delivery to that worker remains required.
- `workId` records provenance; it does **not** impose project/issue isolation.
  Each `arguments` entry requires exact equality for that top-level argument on
  every call. Omitted arguments remain unrestricted within the granted tool.
  `forbiddenArguments` requires listed top-level keys to be absent, even when
  their value is null or empty. For a create-only `save_comment` grant, exclude
  `id` (editing) and alternate parent selectors as shown above. A fixed `issueId`
  alone does not constrain a tool that can select another resource by `id`.
  Delegate only tools whose semantics match the intended boundary.
- Server configuration, connection ID and verified user/workspace IDs bind the
  grant. Disconnect, reconnection, account/configuration changes and revocation
  refuse subsequent calls. Already dispatched provider operations cannot be recalled.
- A bearer-grant session belongs to that grant. An enrolled session belongs to
  its scope and actor and sees only their eligible grants; a different actor,
  scope or authentication path cannot reuse it. Grant records survive restart;
  MCP sessions reconnect. Revocation is durable and affects only the selected
  grant. Missing access never falls back to another account.
- `access list` shows immutable issuance records: `grant.expiresAt` is the initial
  token expiry. `renewable` identifies authority that can continue while its
  assignment remains active; the worker's private file holds its current expiry.
- Host call logs and observers retain worker, work and grant IDs. Exact tracker
  write correlation and durable issue-owner routing use the
  [Linear inbox contract](adr/0168-linear-awareness-is-opt-in.md).
  [Two-worker bot-account evidence](testing/2026-09-23-swarm-integration/README.md#linear-bot-account-and-two-workers)
  verifies live provider writes and independent revocation. The
  [live operator-flow proof](testing/2026-09-23-swarm-integration/README.md#live-human-reply-and-discord)
  verifies human-comment routing, an existing real worker and a delivered Discord reply.

Provider permissions still apply. Grants do not isolate workers that already
have direct access to the owner's OS account, broker or operator bearer. Worker
runtimes must expose only their intended credentials.

Remaining integration: [Swarm host plan](../packages/swarm/README.md#shared-connected-accounts-slices-35).

## External Swarm connections

For an external assignment, `swarm.connectionId` identifies the named connection
alongside `conversationId` and `taskId`. It stays immutable in the grant. Identity,
assignment verification, private grant delivery and every provider call resolve
that same configured coordinator. Disabling the connection makes its grants
unusable without changing another connection's authority.

An enrolled bridge sets `CLANKIE_SWARM_CONNECTION` to that name. Its service
requests include `?connection=NAME`; the server resolves only already configured
connections. Scope names and actor IDs alone do not identify a coordinator.
MCP sessions, tool-list notifications and grants include this connection identity;
changing the query cannot reuse another connection's MCP session. Omit the name
for the embedded coordinator. [Connection setup](cli.md#swarm-coordination).
