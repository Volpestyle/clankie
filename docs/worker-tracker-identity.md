# The swarm uses the connected tracker identity

The tracker account the owner connects to Clankie is the identity of Clankie and
his entire swarm. This applies to every lane, operator seat and hired worker,
across `hire_agent`, Claude, Codex and pi. It selects no fixed
email, display name, workspace or provider. Linear is the current implementation.

Workers write through Clankie's connected tools or an explicitly granted
[worker bridge](worker-access.md). A worker without access asks the lead to make
the write through the connected account. An independently authenticated harness
connector must never substitute for that account.

With a verified Linear app connection, issue and comment creation can carry
the worker's existing name and colored portrait **via Clankie**. This changes
post appearance, not the shared authenticated identity or worker permissions.
See [worker posts and compact handoffs](linear-worker-posts.md) for connection,
publishing, explicit grants and the native-hire limitations below.

## Current enforcement

Every launch Clankie makes switches off the Linear MCP servers the harness would
inherit from the owner's own configuration, for that session only: any server on
Linear's host or named for Linear, plus the claude.ai Linear connector. Claude
sessions get a permission deny rule per server, read from the default and the
configured `.claude.json` (user and local scope) and `.mcp.json` (project scope).
Codex sessions get an `mcp_servers.<name>.enabled=false` override per server,
read from Codex's own effective listing (`codex mcp list --json`); a launch whose
listing cannot be read does not start. The owner's configuration files are not
edited. A worker that needs a tracker write hands it to the lead, who makes it
through the connected account, or uses an explicit grant.

| Path                       | Current behavior                                                                                                                                | Remaining gap                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Clankie's own Linear tools | Use the connected broker account.                                                                                                               | No inherited harness connector on this path.                                                                                                |
| `clankie seat` (Claude)    | Denies every inherited Linear connector; instructions select Clankie's tools.                                                                   | A tracker integration that is neither on Linear's host nor named for it is not recognized.                                                  |
| `clankie seat` (Codex)     | Disables every enabled inherited Linear server in the seat's app-server.                                                                        | Same recognition limit.                                                                                                                     |
| Native `hire_agent`        | Local Claude and Codex hires get the same deny rules and overrides. Local Claude gets the mailbox-only seat bridge; pi its Herdr extension.     | No automatic tracker grant, so writes go through the lead. pi inherits extensions unfiltered. Remote launches read no remote configuration. |
| Explicit worker grant      | `WorkerMcp` verifies account binding, principal, task attempt, tool and arguments on every call. Account replacement invalidates access.        | A grant protects the bridge; it does not remove credentials already available to the worker.                                                |
| Managed `swarm_assign`     | Retired ([ADR 0213](adr/0213-clankie-retires-swarm.md)): Swarm no longer starts workers for Clankie, so every launch goes through `hire_agent`. | None for new work; old routes stay disabled for their receipts.                                                                             |

Following reads the verified connected account's actual Linear notification
inbox. New notifications reach `global-default`; workspace webhook activity is
passive. Self-filtering compares stable provider user IDs, regardless of which
swarm member made the write. When notification actor IDs are absent, Linear's
recipient/self-notification semantics supply that filtering; the current MCP
response omits actor IDs. The [ADR amendment](adr/0168-linear-awareness-is-opt-in.md)
records checkpoint, account-switch and replay behavior.

## Smallest robust worker implementation

Reuse the existing grant bridge and add a launch contract that isolates tracker
access per worker. Do not copy provider tokens into harness configuration, edit
the owner's global configuration, or broaden grants just to make a tool appear.

1. **Bind each launch to the selected Clankie service and access policy.** In
   `apps/clankie/src/captain/captain.ts` and
   `apps/clankie/src/captain/tools.ts`, carry the connected-account policy through
   both assignment and native-hire paths. Keep authorization explicit: a lead
   may issue restricted grants for its task; absence of a grant delegates writes
   back to the lead. Reuse `apps/clankie/src/worker-mcp.ts` for account verification,
   task binding, revocation and provenance. No fixed account is needed.
2. **Add a runtime capability and reject unsupported launches.** In
   `packages/swarm/src/index.ts` and `apps/clankie/src/index.ts`, require the
   runtime's tracker-isolation capability before advertising the route as
   enforcing this rule. In the sibling `swarm-mcp` repository, extend
   `src/coordination/owner-dispatch.ts`, `herdr-dispatch.ts`,
   `herdr-worker-cli.ts` and `worker-harness.ts` under that same directory to
   carry and acknowledge this policy. A missing or old runtime must not silently
   accept it. Publish the runtime artifact and update Clankie's pinned
   `vendor/swarm-mcp-2.0.0-rc.1.tgz` dependency to the new version.
3. **Isolate configured tool access for every harness.** In `swarm-mcp`'s
   `src/coordination/claude-launcher.ts` and `managed-launcher.ts`, construct
   temporary, per-launch configuration with only the approved MCP servers and
   extensions. Claude's explicit MCP configuration needs strict inheritance
   isolation; Codex overrides currently merge with user configuration, and pi
   extensions can install additional tools. Use each harness's supported
   isolation controls and test their effective configuration, including plugin
   and project sources. Preserve model authentication and approved nontracker
   capabilities. Identify allowed connections by Clankie's configured policy,
   not a hardcoded server alias. Unsupported isolation must fail before dispatch.
4. **Apply the same contract to native hires and remote execution.** Update
   `apps/clankie/src/captain/herdr-watch.ts` and `fleet-seat.ts`. Enrolled native
   workers can use `--swarm`; other workers need individually delivered grants
   via the existing private `--grant` path. Keep provider credentials in the
   broker and deliver only the intended grant to the remote worker. A remote
   worker needs a reachable authorized service endpoint. If that cannot be
   supplied, the lead performs tracker writes; never use the remote user's
   personal connector as a fallback.
5. **Refresh pi's granted tools.** In `swarm-mcp`'s
   `src/coordination/pi-worker-extension.ts`, respond to MCP
   `tools/list_changed` and update the registered tool catalog. It currently
   lists once at startup, so a grant issued after an empty initial connection
   does not become visible. Revoked tools must disappear, and bridge calls must
   still refuse revoked grants immediately.

This closes accidental use of inherited tracker tools. It is not an OS sandbox:
workers with unrestricted shell access to the owner's home, broker or operator
bearer can reach other credentials. Stronger isolation would require a separate
OS/container identity and restricted credential access. Do not describe launch
configuration or standing instructions as that security boundary.

## Acceptance evidence for the follow-up

- Extend `apps/clankie/test/fleet-seat.test.ts`, `herdr-watch.test.ts` and
  `worker-mcp.test.ts`, plus `packages/swarm/test/swarm.test.ts` where managed
  route configuration is checked. Cover native and managed launches, local and
  remote endpoints, missing access, revocation and account replacement.
- In `swarm-mcp`, extend `test/coordination-claude-launcher.test.ts` and
  `coordination-codex-launcher.test.ts`; add coverage beside
  `coordination-worker-readiness.test.ts` for the policy capability and pi's
  initial-empty/add/remove tool lifecycle.
- Seed inherited user, project and plugin configuration with a different
  synthetic tracker identity and server aliases. For each harness and launch
  path, show those tools unavailable and a permitted write reaching only the
  selected service's verified account. Preserve approved nontracker tools.
- Switch to a different user and workspace: old grants fail, new grants use
  the new identity, self activity stays quiet, and another actor's notification
  wakes only when following is enabled. `linear-notifications.test.ts` covers
  account replacement without depending on names or emails.
- Run the repository checks after the runtime artifact update. A live proof
  must verify authenticated account and destination before any provider write;
  synthetic tests alone do not prove the live provider identity.
