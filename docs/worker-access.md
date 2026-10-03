# Shared connected accounts

Workers call selected MCP tools through Clankie under explicit manual or project
grants. Provider credentials stay in his broker. Native delivery and tool access
are separate: a mailbox connection alone grants no provider tools.

## Verify the account

`/connect linear` verifies an API key using stable user/workspace IDs, email and
workspace name. For an existing API key or OAuth connection, run `clankie access linear verify`;
`clankie access linear` and `/access linear` show the recorded identity. Confirm
the intended account before delegating. No email is a product default.
The verification command addresses the built-in `linear` broker entry.

OAuth verification calls `get_user` with `query: "me"` and `get_workspace` at
Linear's official MCP endpoint using one locked credential snapshot. MCP-audience
tokens never go to GraphQL. Reverification preserves grants when the stable
user/workspace identity is unchanged; a changed identity requires new grants.
An unverified connection cannot receive worker grants. Verification identifies
the connected account; it does not sign in as a different user.

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

## Project access

The owner grants a project's agents tools with:

```sh
clankie access project kh2 linear
clankie access project kh2 linear --tool get_issue --tool save_comment
clankie access list
clankie access revoke GRANT_ID
```

`NAME` is the saved project ID. Create it explicitly first with the local owner command
`clankie project add kh2 --workspace /absolute/canonical/kh2-repository`. This
saves one exact local workspace, rejecting duplicates, nested overlaps, missing
directories and path aliases. It preserves all existing role/cap settings and
creates no grant or assignment.
`access project` does not create a project, approve a directory, or copy a fleet grant.
The owner API binds `project`, `principalId: "project:NAME"`, and
`workId: "project:NAME"` to the same project and the currently verified connected
account. With no `--tool`, issuance selects the server's current worker-safe tool
set, excluding publishing tools that require an exact persona restriction.
Newly added server tools do not automatically enter an existing grant.
No bearer is delivered for a project grant, and its tools remain available until
revocation while membership and the connected account stay valid.

Each list and call resolves the current agent again. A host-recorded actual hire
assignment takes precedence; a stale assignment denies access instead of falling
back to a directory. Otherwise the service reads the native agent process's
actual working directory and checks it against the project's approved workspace.
Character roles, tracker files, imported settings assignments, pane labels and
fleet links do not prove a hire. Two matching projects deny access, including
nested workspace approvals. Paths must have their actual canonical spelling;
symlink aliases, case mismatches and missing directories deny access.

The implemented proof is local macOS: the separate listener checks the socket's
OS-observed owner and ancestry against the connected Herdr pane, then binds the
native foreground harness PID and start time, pane shell PID and start
time, and current Herdr socket/session plus native agent session identity.
The service reads both `agent get` and `pane process-info` from that pinned Herdr
socket, requires the same pane and terminal/session before and after observation,
and checks the OS executable mapping against its installed launcher. A matching
process name alone is insufficient. Node launchers additionally require the exact
installed script as the first interpreter argument. The service's existing machine ID for
this host is `local`; approved workspaces use `machineId: "local"` and
`platform: "posix"`. This is not a fleet name or a caller-selected machine ID.
A bridge in another pane, another job in the same pane, or a replacement process
cannot reuse that identity. Clankie-hired private Codex app-servers also use the
service's own launch registration: the server PID lifetime, exact pane/binding,
and authoritative native thread ID are bound before its first brief. Requests
must match that live registration, the fresh native TUI proof and an actual hire
assignment. They never inherit a project solely from the pane's cwd. Disposal,
PID reuse or a replacement thread denies the old server. MCP sessions expire after 15 minutes idle and are
bound to the exact project and process identity.

Workspace exit, assignment invalidation, account change and revocation are
checked on every list and call, without a one-minute authorization cache. The
bridge may refresh its displayed list later; a stale displayed tool cannot run.
A hire explicitly assigned to a project keeps that assignment when its cwd
changes; workspace-derived membership follows the fresh cwd. A newly started
private server has no project tools until its actual hire assignment is recorded;
the bridge refreshes its displayed tool list within a minute.

### Owner cutover from fleet grants

Existing fleet grants are retired for access immediately. They remain on disk
for inspection and explicit revocation; no migration, copy or revocation runs
implicitly. `clankie access fleet` explains the replacement command and refuses
to issue another session-wide grant.

The old pinned CLI cannot register projects, and the old service cannot issue
project grants. The owner may first register the exact workspace using the new
checkout CLI, without restarting the service. From the new checkout's root:

```sh
# Only if this project does not already exist:
pnpm_config_verify_deps_before_run=false pnpm --filter @clankie/tui exec tsx bin/clankie.ts project add kh2 --workspace /absolute/canonical/kh2-repository
```

This owner-authenticated command saves the workspace locally and issues no grant.
Do not broaden an approval to a parent such as `~/dev` merely to keep an owner
pane's tools. Next, land this version, re-pin the installed CLI to that landed
checkout through the normal installation procedure, and restart the service on
the new version. Existing fleet grants stop providing bridge tools at that
restart. Expect a temporary loss of those tools until the owner explicitly
reissues project grants and restarts or resumes eligible panes.

Using the new pinned CLI in the owner's terminal, inspect the intended account
and records, issue the selected project tools, then retire the old records:

```sh
clankie access linear
clankie access list
clankie access project kh2 linear --tool get_issue --tool save_comment
clankie access revoke OLD_FLEET_GRANT_ID
```

Repeat reissue and revocation for each intended project/server/old grant. Review
argument restrictions before reissuing; the short command grants unrestricted
arguments for each named tool. Restricted project grants can be submitted through
the same owner-authenticated worker-grants API with exact tool rules.

An owner-started agent receives project tools by the same proof. Start or resume
its native TUI **from the actual approved repository**, for example:

```sh
cd /absolute/approved/kh2-repository
codex --no-daemon
# or, for a Claude pane:
claude
```

Changing the parent shell's directory while an agent is already running does not
change that agent's cwd. An owner pane running from `/Users/james/dev` therefore
needs a deliberate restart/resume from its approved repository using the currently
installed native executable; this also applies to the lead/root pane. Save the
ongoing handoff before restarting or resuming that pane. There is no
owner-pane exemption or automatic assignment. Keep elevated-shell `--no-daemon`
where required; it changes how Codex starts, not the access rules.

SSH/PC fleet links still carry native messages, but they do not yet provide the
OS process proof needed for project tools (VUH-1563). Remote project calls deny
access. Shared daemons, unregistered detached processes, foreground shell
or Node wrappers without the exact installed script in their retained argv,
unsupported harnesses and non-macOS local listeners also lack
this project's foreground-agent proof. Pi's installed launcher rewrites its process title and removes the script argv.
Its usual launch therefore remains an engineering gap in VUH-1558: generic Node
and the name `pi` do not prove which script runs. Completing that supported path
requires trusted script-launch provenance, not a new grant or owner permission.
An agent still running an older executable after its installed launcher changes
also needs a deliberate restart/resume. A successful mailbox/doctor local
membership probe alone does not establish project-tool membership. Actual live
KH2/Rivals cutover remains an owner-run acceptance check; deterministic fixtures
do not establish that it has happened.

## Boundaries and limits

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
- Manual MCP sessions belong to one grant; project sessions belong to exactly one
  verified project and native occupant. A different grant, project or occupant cannot reuse the session.
  Grants and revocation records survive restart; MCP sessions reconnect.
- Worker publishing tools require an exact `personaId` restriction. Project grants
  that select the server's whole tool set exclude these publishing tools.
- The service retains delegated principal, work and grant provenance. Grant
  restrictions do not remove credentials already available to the worker.

Provider permissions still apply. Launch isolation is not an OS sandbox: workers
with direct access to the owner's broker or operator bearer can reach other
authority. Use the [tracker identity contract](worker-tracker-identity.md) and
[Linear worker publishing](linear-worker-posts.md) for the remaining boundaries.
