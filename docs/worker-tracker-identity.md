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
edited. Codex launches also set
`apps.<discovered-id>.enabled=false` for every Linear app connector found by
runtime name in Codex's native `app/installed` catalog, which is absent from
`codex mcp list`. Discovery runs a bounded read-only app-server without creating
a thread or model turn; an unreadable catalog refuses the launch. This session-only
override applies to local and remote hires and operator seats; other apps stay
available. Existing running sessions retain their launch configuration.
IDs are resolved on the selected machine/account rather than assumed universal;
Codex supports
[per-app enabled settings](https://learn.chatgpt.com/docs/config-file/config-reference).
A worker that needs a tracker write hands it to the lead, who makes it
through the connected account, or uses an explicit grant.

| Path                       | Current behavior                                                                                                                            | Remaining gap                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Clankie's own Linear tools | Use the connected broker account.                                                                                                           | No inherited harness connector on this path.                                                                                                |
| `clankie seat` (Claude)    | Denies every inherited Linear connector; instructions select Clankie's tools.                                                               | A tracker integration that is neither on Linear's host nor named for it is not recognized.                                                  |
| `clankie seat` (Codex)     | Disables every enabled inherited Linear server and every Linear-named app discovered on its selected account.                               | Same server recognition limit; an app renamed to omit Linear is not recognized.                                                             |
| Native `hire_agent`        | Local Claude and Codex hires get the same deny rules and overrides. Local Claude gets the mailbox-only seat bridge; pi its Herdr extension. | No automatic tracker grant, so writes go through the lead. pi inherits extensions unfiltered. Remote launches read no remote configuration. |
| Explicit worker grant      | `WorkerMcp` verifies account binding, principal, tool and arguments on every call. Account replacement invalidates access.                  | A grant protects the bridge; it does not remove credentials already available to the worker.                                                |

Worker and operator Claude plugins also carry a local `PreToolUse` guard that
denies inherited Linear-named MCP servers (including `linear-server` and the
claude.ai connector), even in hand-started sessions without a linked pane or
working bridge. Reads are denied too; use Clankie's connected tools. The plugin's
SessionStart notice identifies that boundary visibly. Loading neither plugin
adds no guard to a plain Claude session. No user profile configuration is changed.
Existing sessions need the updated plugin loaded through the normal native
plugin update/reload or a deliberate resume; a source change alone is not proof
of a running session's guard.

For a hand-started session without a plugin, use `clankie claude` for the operator
seat or load the worker plugin for a fleet session and publish through
`clankie_tools` / `clankie_call`. An unlinked worker asks its lead to publish.
The owner keeps personal `linear-server` use in plain Claude. Any profile-wide
deny remains an owner decision; this feature does not edit it.

Owner and human wake selectors require an explicit signed `actor.type=user`;
missing types and app/integration actors do not qualify even when their ID or
email matches an owner. Host-recorded worker provenance still takes precedence.
A user-authenticated external connector can emit the same signed user actor as
Linear app/web comments: the provider's documented envelope has no reliable
client-origin flag. That unknown origin cannot be identified as human from
actor ID alone. Preventing the plugin's connector write is the structural fix;
the wake rule rejects knowable non-user/worker origins without suppressing real
owner comments. See [Linear's webhook envelope](https://linear.app/developers/webhooks).

Signed Linear webhooks that pass the actor/type rules wake one ordinary chat:
the project's configured lead chat, otherwise `global-default`
([ADR 0214](adr/0214-linear-wakes-require-attribution-and-rules.md)). The
connected account's Linear notifications are only marked read after that chat
confirms the wake. Self-filtering compares stable provider user IDs, regardless
of which fleet member made the write.

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
