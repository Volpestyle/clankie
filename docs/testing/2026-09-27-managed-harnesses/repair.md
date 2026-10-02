# Managed harness canary repair — 2026-09-27

VUH-1407 remains in progress until the revised candidate passes the lead's live
Mac default-runtime canaries. No service restart, dependency install in Clankie,
or push was performed by this implementation owner.

## Observed failures and repairs

- **Codex MCP mount:** `-c mcp_servers."swarm"...` creates a server whose name
  contains literal quotes. A `config/read` request to the installed Codex 0.157.1
  reproduced it. The launcher now uses validated bare path segments. The unrelated
  localhost MCP connection still fails, but actual Swarm sync and lifecycle calls
  succeed alongside it; it does not prevent Swarm startup.
- **Codex lifecycle permissions:** after mounting, automatic approval review
  rejected `swarm_inbox` and `swarm_task` under policy `never`. James explicitly
  approved per-session preapproval of those two tools on the enrolled Swarm server.
  Other MCP and shell approval policies remain unchanged.
- **Pi package:** importing the installed pi extension failed with
  `ERR_MODULE_NOT_FOUND` for `@modelcontextprotocol/client`. The b62a68f tarball
  manifest declared it; the Clankie lockfile's same-version snapshot omitted it.
  The candidate lockfile now contains the client and its dependency graph, and a
  regression test compares the archived manifest against that snapshot. Release
  and clean-package probes import the extension so module resolution is exercised.
- **Pi model:** an actual pi 0.84.2 run found the inherited xAI OAuth refresh token
  invalid. James selected OpenRouter Kimi K3, now explicitly configured on pi routes
  as `openrouter/moonshotai/kimi-k3`. Terminal pi model/extension errors stop the
  wrapper instead of being hidden behind a readiness timeout.
- **Retained-route cancellation:** switching the default back to Claude disabled
  the Codex/pi routes and made cancellation return `termination_unavailable`.
  Disabled Herdr routes now retain stop authority only for their fingerprint-checked
  tokens. New provisioning stays disabled. A denied POSIX group probe returns
  unverified termination, never a fabricated stop receipt or uncaught exception.

## Original live intents reconciled

[Reconciliation evidence](reconciled-intents.json) records the original task IDs,
intent IDs and provisioning tokens. Both are `released`, and their failed tasks
are `cancelled`, not completed canary successes. No replacement live intents were
created. For the installed build's reconciliation, the existing harness route was
briefly selected, the same intent cancelled/released, and Claude restored. The
shared PC coordinator/relay was preserved.

## Validation boundary

The opt-in fixture invokes the real Codex or pi executable and production Swarm
owner, MCP, wrapper and extension from a clean extracted package. Its Herdr
transport is synthetic and its coordinator is an isolated local test instance.
It is not a live Clankie deployment canary. Both models must call Swarm to become
ready, read an instruction artifact containing `SWARM_REAL_SNAPSHOT_OK`, acknowledge
assignment delivery, finish `completed`, release while the route is disabled, and
exit the owned wrapper cleanly.

The installed Clankie release-closure test still fails because the old dependency
graph cannot resolve the client. This is the reproduced installation defect, not
a successful candidate release check. The lead must install the corrected graph
and rerun that check in the upgrade window.

## Final candidate and results

- Swarm revision: `a72a2d3afa88274a60747216b8d401ab279204b5`.
- Tarball SHA-256: `dfa3f9d1a33b93da5b6373adbd4963d93fa6536e87067ad070fc457a144ff029`.
- Schema remains 15; the separate interactive schema-15 migration is not merged.
- Full Swarm check: 205 passed, zero failed, 1,815 assertions; Python test,
  typecheck, build and package verification passed.
- [Clean production install](package-install-repair.json): passed, frozen lockfile
  unchanged, no source/dev dependencies, both MCP client and server present.
- [Real Codex log](real-codex-repair.log): 17 assertions passed, task
  `abaf23ca-dd83-4547-86b4-810ad35103e3` completed and released; clean wrapper exit.
  Native turn metadata confirms `gpt-6-astra`, rather than relying on model self-report.
- [Real pi log](real-pi-repair.log): 17 assertions passed, task
  `e678c5e4-f1e5-46c2-af39-85ae6349eef1` completed and released; clean wrapper exit.
- [Sanitized launch receipts](real-harness-receipts.json) pin the executables and
  model selections. These test tasks are separate from the preserved live failures.
- Clankie: all 27 typecheck tasks passed; seven route tests passed; the new vendor
  dependency-snapshot test passed. The old installed release closure remains
  deliberately unaltered and fails on its missing client until the lead installs.

Next: the lead installs the corrected candidate and lockfile, coordinates matching
shared owners/relay clients, runs the installed release check, then runs new live
acceptance canaries. The original failed intent tokens remain terminal and released.
