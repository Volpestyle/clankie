# VUH-1724 — worker fleet tools and receipt reconciliation

Candidate branch `remy/worker-fleet-tools`, based on `origin/main` `8fcf47a5`.
The [bug](https://linear.app/vuhlp/issue/VUH-1724/worker-fleet-tools-time-out-and-unresolved-reports-block-later)
was filed through the worker's native `clankie_call` route after verifying the
connected Clankie OAuth actor. No operator Linear fallback was used.

## Findings and change

The worker path is `clankie mcp --fleet` → worker bridge → local-process fleet
listener → `WorkerMcp` → connected MCP host → the verified Linear actor. Unlike
the lead path, it has a thirty-second total request budget and fresh native fleet
admission. The host also requested optional native write attribution for reads,
then revalidated it repeatedly. Each proof could perform more socket census,
Herdr and project observations before the first provider request. Exact calls
also checked unrelated connected accounts. Under fleet concurrency, this work
could exhaust the budget before Linear saw the request.

James reported a load average of 856 on eighteen cores while six simulators and
nine workers' checks ran. That is a plausible trigger for these intermittent
failures, rather than evidence of a different Linear actor in the worker lane.
He subsequently reported the 22:53 OOM: 127/128 GB in use and full swap while
five builders ran typechecks and six simulators were booted. Further heavy checks
must use his fleet limiter; the checks below had already completed.
The candidate removes measured extra work and propagates cancellation; it does
not claim that every historical timeout had a lane-specific cause or that a
thirty-second deadline can always succeed under that load.

Reads now skip optional publication attribution. Writes share at most two seconds
and one quarter of their caller budget for that attribution; unavailable or late
proof cannot invent an author or revoke an independent connected-account grant.
Publication paths still enforce their required author proof at the actual write
boundary. Exact invocation and receipt lookup check only the selected account;
catalog discovery still checks the offered accounts. Fleet, account, configuration,
revocation and final dispatch fences remain in place. No mutation retry was added.

Request cancellation previously stopped waiting for local admission without
reaching its queued native observations. The deadline now follows socket census,
Herdr reads, project proof and private Codex birth/occupant checks. Queued helper
work can be removed on cancellation; active replies drain before the next job.
Authentication deadline failures now return HTTP 504. Earlier native helper
unavailability still returns the existing HTTP 403
`local_process_membership_required`, just like failed membership; it does not
prove true nonmembership or a Linear permission denial. A real HTTP/helper
regression reproduces that pre-provider 403. The historical comment's exact
response body was not recovered, so Tess's specific cause remains unconfirmed.

The report wedge has a separate cause. The service had a matching durable
`notSent` fence and its authenticated lookup returned `definitive: not_sent`.
The running 0.6.2 worker parser accepted only positive stored receipts; updating
runtime/plugin files did not replace its already-imported code. Current receipt
code, landed in `6f9ad673`, already accepts the truthful sealed negative.
`1eb8ea93` keeps the operator's outbound pump alive; it does not reload the
worker's inbound parser. This candidate preserves production receipt behavior
and adds a historical-client → refreshed-client boundary regression.

## Focused evidence

Fresh frozen installation in an owned worktree; no copied dependency/cache
directories or node_modules symlink. No full gates, eval, deployment, runtime
receipt edit, account/grant change or agent restart.

- Host/account slice: 62 tests across worker bridge concurrency, remote fleet
  grants, conversation attribution, MCP host, worker call receipts and Linear
  publishing. New boundaries exercise the actual stdio bridge, local HTTP,
  credential/settings stores and loopback MCP provider. Reads with stalled optional
  attribution still reach the provider; bounded writes retire their optional
  proof; exact account lookup avoids an unrelated broken connection.
- Inbound receipt slice: 21 tests in four files. The new integration drives actual
  HTTP service routes, captain and durable fences through the complete historical
  0.6.2 client and current client. It proves terminal settlement after service/client
  replacement, no replacement POST during reconciliation, late-original refusal,
  and retention on unauthenticated or mismatched lookup. External Herdr observation
  is explicitly a fixture; the historical source hash/provenance is checked.
- Cancellation slice: 77 tests in six files, run serially. Actual HTTP, child
  transport and owned Unix sockets prove queued-job removal, active-reply drain,
  private Codex deadline propagation, recovery-socket termination and both fresh
  census/pane checks. Scripted native replies are explicit observation fixtures,
  not a claim of kernel membership. Existing native transport checks separately
  passed 13 tests with one skipped. An initial parallel run crossed an existing
  one-second active timeout under load; the unchanged check passed serially.

The affected app typecheck passed after assembling every slice. Scoped lint and
formatting passed. A pending recovery connection retains its existing one-second
handshake bound; an acquired socket terminates immediately on cancellation.

Live worker observations on the deployed baseline include successful authenticated
identity and issue reads and creation of VUH-1724, alongside earlier timeout/403
failures. A later baseline issue read completed in 30,008 ms after discovery took
5,049 ms. Those intermittent successes are baseline observations, not validation
of this unshipped candidate. The exact original inbound receipt was read through
the admitted local-process route and was already sealed as not sent. No original
report or later report was replayed.

## Lead proof after integration

1. Integrate the candidate and run Pell's full gates. Update the local runtime
   through its owned lane, then prove several concurrent worker Linear reads and
   one authorized disposable issue/comment write use the intended actor within
   the request budget. Retain status/reason and receipt IDs; reconcile uncertain
   writes instead of retrying them. Confirm tools-off, account replacement and
   changed native ownership still refuse before dispatch.
2. Cancel workers while admission is queued, then issue an independent read.
   Verify canceled jobs retire, the independent proof completes, and no canceled
   request reaches the provider. Verify expired authentication is a timeout rather
   than a fabricated membership denial.
3. For each already-running older bridge, use its original controller to refresh
   only the Clankie MCP connection, preserving the exact thread, account home and
   receipt. Managed Codex's existing isolated-config path changes
   `mcp_servers.clankie.env.CLANKIE_CATALOG_REVISION` through `config/value/write`,
   then calls `config/mcpServer/reload`; the next model step replaces that connection.
   Embedded/remote clients without that controller require the owner's exact-session
   reconnect with a current bridge after the old runtime unloads. Reloading an
   unchanged old cached plugin cannot update its parser. Remy's isolated config
   already selects `clankie mcp --fleet`. Do not restart a shared daemon or fork.
4. Invoke `message_clankie` once to reconcile the retained original. Its matching
   terminal `definitive: not_sent` result clears that exact claim without sending
   a replacement. Invoke separately to send the later report; confirm the lead's
   stored receipt and retained report. Stored does not prove model attention.

Actual same-thread client reload and lead receipt of a subsequent report remain
live verification. Source changes and fixture tests do not establish them.
