# Shared connected accounts

Workers call selected MCP tools through Clankie under explicit manual or fleet
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

## Fleet access

A fleet is one Herdr session Clankie is connected to, here or on a linked
machine ([ADR 0212](adr/0212-machines-and-devices.md), VUH-1527). Membership is
the binding: every agent in that session, hired or not, holds the fleet's grants
through the `clankie-worker` bridge over the fleet's link.

```sh
clankie access fleet kh2 linear                     # the server's worker-safe tools
clankie access fleet kh2 linear --tool get_issue --tool save_comment
clankie access revoke GRANT_ID
```

- With no `--tool`, the grant takes every tool Clankie's connected account
  exposes on that server, except worker publishing, which must name the persona
  it writes as. Calls go out as his connected account, with the fleet recorded
  as the delegated principal.
- No bearer is issued or printed. The fleet's link token is the identity, and it
  reaches only that fleet; another fleet's link sees none of its grants.
- A fleet grant does not expire. Each list and call rechecks the live grant and
  the connected account, and revocation takes the tools away within a minute
  (the bridge refreshes its list and tells the session it changed).
- Claude sessions load the bridge as the worker plugin. Codex sessions on that
  machine load it as the `clankie` MCP server that `clankie herdr prepare`
  registers, inheriting the pane's `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`;
  a session started before that registration needs a restart.

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
- Manual MCP sessions belong to one grant; fleet sessions belong to exactly one
  authenticated link. A different grant or fleet cannot reuse the session.
  Grants and revocation records survive restart; MCP sessions reconnect.
- Worker publishing tools require an exact `personaId` restriction. Fleet grants
  that select the server's whole tool set exclude these publishing tools.
- The service retains delegated principal, work and grant provenance. Grant
  restrictions do not remove credentials already available to the worker.

Provider permissions still apply. Launch isolation is not an OS sandbox: workers
with direct access to the owner's broker or operator bearer can reach other
authority. Use the [tracker identity contract](worker-tracker-identity.md) and
[Linear worker publishing](linear-worker-posts.md) for the remaining boundaries.
