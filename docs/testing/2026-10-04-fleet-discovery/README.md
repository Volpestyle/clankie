# Private fleet discovery isolation

VUH-1631, 2026-10-04. A private service previously replaced
`~/.clankie/links/default-local.json` despite having its own `CLANKIE_STATE`.
Its shutdown removed that file, breaking the production worker route.

The publisher now uses the service state root's `links` directory. Native
bridges and doctor use the same existing `CLANKIE_STATE` selection. Ordinary
local hires explicitly carry the absolute state path through external Herdr
and Codex's MCP environment forwarding. SSH fleets retain their own machine's
state; trusted preallocation keeps ownership of its complete environment.
Discovery remains metadata only. No new registry, credential or port setting
was introduced. Admission and final dispatch fences are unchanged.

`local-fleet-discovery.test.ts` exercises publication and cleanup with separate
state roots sharing one Herdr socket. It checks production descriptor bytes and
the native bridge's selected read route before private publication, after it,
and after normal/failure cleanup. Process admission is mocked; the existing
local fleet grant tests retain their admission and revocation coverage.
The regression starts no whole Clankie service or native agent.

Worker-link and doctor tests cover private selection, missing-private refusal
without shared fallback, whitespace overrides, and Codex forwarding. Prepared
hire tests cover carrying a relative override as an absolute path to the adapter
and native pane. Connected production reads are checked separately through the
worker's real Clankie tools. A whole private-service acceptance run waits for
lead integration of this fix.
