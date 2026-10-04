# The fleet uses the connected tracker identity

The tracker account the owner connects to Clankie is the identity of Clankie and
his entire fleet. This applies to every lane, operator seat and hired worker,
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

| Path                       | Current behavior                                                                                                                            | Remaining gap                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Clankie's own Linear tools | Use the connected broker account.                                                                                                           | No inherited harness connector on this path.                                                                                                |
| `clankie seat` (Claude)    | Denies every inherited Linear connector; instructions select Clankie's tools.                                                               | A tracker integration that is neither on Linear's host nor named for it is not recognized.                                                  |
| `clankie seat` (Codex)     | Disables every enabled inherited Linear server in the seat's app-server.                                                                    | Same recognition limit.                                                                                                                     |
| Native `hire_agent`        | Local Claude and Codex hires get the same deny rules and overrides. Local Claude gets the mailbox-only seat bridge; pi its Herdr extension. | No automatic tracker grant, so writes go through the lead. pi inherits extensions unfiltered. Remote launches read no remote configuration. |
| Explicit worker grant      | `WorkerMcp` verifies account binding, principal, tool and arguments on every call. Account replacement invalidates access.                  | A grant protects the bridge; it does not remove credentials already available to the worker.                                                |

Following reads the verified connected account's actual Linear notification
inbox. New notifications reach `global-default`; workspace webhook activity is
passive. Self-filtering compares stable provider user IDs, regardless of which
fleet member made the write. When notification actor IDs are absent, Linear's
recipient/self-notification semantics supply that filtering; the current MCP
response omits actor IDs. The [ADR amendment](adr/0168-linear-awareness-is-opt-in.md)
records checkpoint, account-switch and replay behavior.

## Remaining isolation work

Native Claude and Codex launch paths deny recognized inherited Linear connectors.
That recognition is not a general provider sandbox: differently named or hosted
tracker tools and pi extensions still need effective-configuration review. Remote
launches must establish their own native isolation and reach the selected service
through its fleet link. No missing bridge permits using a personal connector.

Use [fleet connected tools or manual grants](worker-access.md). Fleet admission
reaches verified accounts through two meta tools; manual grants retain argument
restrictions, expiry and revocation. Keep provider tokens in the broker and
owner-global configuration unchanged. When delegated access is unavailable,
the lead makes the tracker write through Clankie's connected account.

Tests cover grant isolation, durable revocation, account replacement and native
launch deny rules. A live provider proof must verify the authenticated identity
and destination before writing; synthetic tests do not establish that identity.
