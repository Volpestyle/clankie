# Worker names and portraits in Linear

Clankie connects one workspace-owned Linear app. A worker's issue or comment
shows its existing fleet name and colored Clankie portrait, **via Clankie**.
These are author appearances on posts, not separate email accounts, seats,
assignees, or mentionable Linear users. Regular updates use the app identity.
[ADR 0207](adr/0207-workers-publish-through-one-clankie-app.md) records the choice.

## Connect the application

In the intended Linear workspace, create an OAuth application in Settings → API
and enable **client credentials tokens**. Name it Clankie and use its portrait.
Linear also requires a redirect URI when creating the app; a loopback URI such
as `http://127.0.0.1:4310` can satisfy this for a local installation. The client
credentials flow does not use it or enable interactive OAuth callbacks.
This installation method is for the workspace that owns the application.
It requests `read,write`, without admin access.

Use `/connect linear` → **Connect a Clankie app**, or enter its client secret
through stdin with `clankie accounts connect linear-app --client-id ID --secret-stdin`.
Do not put the secret in command arguments or a tracked file. The owner API is
`POST /v1/accounts/linear/app` with `{ "clientId": "…", "clientSecret": "…" }`.
Paired remote devices need Take Control and the encrypted gateway envelope.

Clankie verifies `viewer.app`, the actual provider actor and workspace before
saving. `clankie accounts` reports that app and workspace. Credentials stay in
the broker; renewal verifies the same actor and workspace. A failed connection
leaves the previous one intact. Connecting replaces the existing `linear`
connection, invalidating old worker grants; issue new grants explicitly.

The ordinary user OAuth/API-key paths remain available. They cannot publish
worker appearances. Disconnecting deletes the credential locally and attempts
provider token revocation; remove the application in Linear to retire its client
credentials too.

## Publish a result

Read the fleet's existing `personaId` (`clankie agents contacts`). The operator tool bank
offers `linear_create_worker_comment` and `linear_create_worker_issue` only when
a verified app is connected. The service resolves that persona's current name
and color; callers cannot supply arbitrary author names or icons.

```bash
clankie linear post comment --json-stdin <<'JSON'
{
  "personaId": "EXISTING_PERSONA_ID",
  "issueId": "TEAM-123",
  "body": "Implemented the change. Evidence: https://example.test/proof. Open: live verification."
}
JSON
```

A comment accepts `parentId` (comment UUID) for a thread reply. An issue accepts
`personaId`, `teamId` (UUID), `title`, and optional `description`, `projectId`,
`parentId`, `priority`, `labelIds`. Use `post issue --json-stdin`. Receipts include
the Linear URL and persona ID. An uncertain mutation is never automatically
retried: inspect Linear before trying again to avoid duplicate posts.

This CLI is an **operator** path. A restricted worker uses the existing
[worker bridge](worker-access.md) with a grant whose tool arguments pin its
exact `personaId` and, for bounded comments, `issueId`. The grant's principal,
work, account and attempt checks still apply. Workers without that bridge send
their report to the lead, who publishes it with their persona. Native hires do
not automatically receive a tracker grant or isolation from inherited tracker
connectors; [current enforcement](worker-tracker-identity.md) describes the gap.

Write receipts retain persona and delegated-worker provenance for reply
context. Author appearance does not itself route a reply to a pane or create
new permissions. Self-notification filtering still uses the real app user ID.

## Compact handoffs

Native hires and managed assignment briefs ask workers to end a completed turn
with a short report: outcome, evidence links, open decisions and unresolved
gaps. The native completion wake includes at most 3,000 characters of the final
report and marks truncation. The lead starts there and follows the evidence;
it reads the retained worker thread or terminal only when something is missing
or needs investigation. There is no second summarizer or transcript copy.

Publish durable results on the issue; keep routine coordination in Swarm or
the worker's native thread. The lead still owns review and integration.

## Portrait assets and activation

Six unchanged PNG exports from the app's garden live in
`apps/docs/site/agents/clankie-{green,teal,amber,dusk,onyx,azure}-v1.png`.
The docs build publishes them at `https://docs.clankie.bot/agents/…`.
Deploy those files before the first live attributed post; a local test cannot
prove Linear can fetch a portrait. These are the standard colored characters;
custom persona images and accessories are not included in this first path.

## Provider references

- [Linear app actor and per-post author appearance](https://linear.app/developers/oauth-actor-authorization)
- [Linear OAuth and client credentials](https://linear.app/developers/oauth-2-0-authentication)
- [Linear MCP authentication](https://linear.app/docs/mcp)
