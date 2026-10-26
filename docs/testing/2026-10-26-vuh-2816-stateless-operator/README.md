# VUH-2816: restore stateless bearer tools without lead attribution

The consumed GO14 root gate on clean `d0ab3ae67d333cd30428cc0f996e1c54368382b1`
(base `587d8b8e74389cb669a8d0cfc7970ab6b02bc2b9`) failed. The actual response at
`linear-wake-receipts.integration.test.ts` was HTTP403 `seat_binding_required`.
The 48-file caller inventory exposed a production regression: ordinary
`clankie linear read/graphql/post/catalog` opens bearer-only MCP. The blanket
seat guard rejected it before any stateless tool call.

GLOBAL16 authorized option (a). An operator MCP URL without a conversation ID
now creates an explicitly neutral canonical bank. It never calls seatContext
or captures global-default, room authority, target, callbacks or lead closures.
Stateless tools use their existing bearer authority. Lead tools return typed
`conversation_binding_required`; dispatch/reconciliation refuses before durable
receipts or effects. Every named conversation and event poll/ack/reply retains
the native socket/ancestry/nonce guard. Session reuse cannot cross these contexts.
No client flag or generalized authorization system was added.

The real CLI binary subprocess reads a local Linear fixture through production
HTTP/MCP and the canonical tool bank, without an injected callTool or model.
A real captain + HTTP MCP SDK session proves neutral discovery works while
message_seat, worker_reports, acknowledge_worker_reports and reconciliation
refuse, and unbound HTTP poll/ack/reply refuse. A genuinely bound seat retains
its report and can settle it. The report was first offered by that bound seat;
the neutral client cannot change its offered/read state.

Caller repairs use real OperatorSeatBindings plus the existing controlled raw
kernel observation seam, distinct launcher/harness/bridge/socket identities,
real PUT registration and nonce-bearing requests. Those observations are
stand-ins, not native acceptance. The separate native suite executes real
isolated launcher/harness/bridge processes and the native helper. Existing
routing, isolation, sourceHash and deadlines remain. Notification/drop observers
match the MCP pathname so explicit query strings preserve the original TCP/SSE
failure experiments. Other permissive fixtures remain post-admission behavior
coverage only; passing them is not proof of native admission.

The no-bail before run completed all48 files: 537pass/57fail/0skip across594tests.
Intermediate failures, typecheck's Http2Bindings fixture error, the new no-effect
check's missing owner authority, and their repairs remain in the archive. The
no-effect assertion now reads through the authenticated production fixture route.
The first nonce mutation selector selected zero tests and is explicitly NOT
proof; the corrected selector executes the required negative cases.

Carried provenance: original import checkpoint
`cb6c107343de02625eee7d214b70b15e0a22f899`, original base
`83b157cfcfe946dc3af600472cb482a687b39a43`, import net SHA256
`3373be6f63fa384a8b239a334cbaee2f4007f956036f8fe85aee03e66d4f0844`.
All prior CHANGES and R3/GO10/GO14 failures remain preserved. Wren's earlier
182d2030/b5a5919d SOURCE approval applies to the old bytes only; this production
repair requires a new exact review. Launchers and registry are unchanged from R6.

OPEN: real ClaudeN shell depth/exec/fork topology; Codex npm shim to native
app-server; OpenCode/Grok parentage and config consumption; Prime's verified
kernel PID/lifetime/launch edge; installed/original operator acceptance. The
same-user own-child/unheld-conversation race remains the accepted stray-guard
limit. No source approval closes these. GLOBAL retains closure and deploy
acceptance. No root gate, rebase, revalidation, push, rollout, live harness or
service effects, owner/inbox mutation, credentials/settings/account changes,
or eval was performed for this repair. Native context telemetry is unavailable.

## Final focused proof

- Full no-bail caller set: **48 files, 595/595 pass, zero skipped**, source hashes stable during the final run. Before repair: **537pass/57fail/594tests**.
- Both isolated native process tests execute with the helper; they are not skipped.
- Enabling global conversation capture in neutral assembly fails the new unbound MCP proof. Disabling nonce comparison fails wrong/missing-claim cases (2fail/1pass in the selected negative set). Ignored Vite transforms leave tracked production bytes unchanged.
- Final package typecheck passes source and all15 test partitions; scoped lint/format, swallowed-rejection preflight and doc links pass. Commands and exit codes are retained in the archive.

## Complete caller matrix

Counts are passed/failed. Shared helpers and direct/indirect route chains are retained in the archive's HTTP/MCP inventories. A green post-admission fixture does not establish native launch compatibility.

| Caller                                                                 | Before | After | Coverage                                           |
| ---------------------------------------------------------------------- | ------ | ----- | -------------------------------------------------- |
| `apps/clankie/test/claude-delivery-reconciliation.integration.test.ts` | 8/1    | 9/0   | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/fleet-link.test.ts`                                 | 10/0   | 10/0  | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/joined-seats.integration.test.ts`                   | 1/0    | 1/0   | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/lane-mcp.test.ts`                                   | 21/0   | 21/0  | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/linear-cli-lane.integration.test.ts`                | 0/1    | 1/0   | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/linear-connected-receipts-integration.test.ts`      | 0/3    | 3/0   | Stateless provider or shared consumer fixture      |
| `apps/clankie/test/linear-native-delivery.integration.test.ts`         | 11/0   | 11/0  | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/linear-owner-settings.integration.test.ts`          | 1/0    | 1/0   | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/linear-request-budget.integration.test.ts`          | 23/2   | 25/0  | Stateless provider or shared consumer fixture      |
| `apps/clankie/test/linear-revision-receipts-integration.test.ts`       | 0/2    | 2/0   | Stateless provider or shared consumer fixture      |
| `apps/clankie/test/linear-settings.integration.test.ts`                | 1/0    | 1/0   | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/linear-wake-receipts.integration.test.ts`           | 0/13   | 13/0  | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/linear-webhook.integration.test.ts`                 | 11/1   | 12/0  | Stateless provider or shared consumer fixture      |
| `apps/clankie/test/local-fleet-grants.test.ts`                         | 2/0    | 2/0   | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/mcp-receipts-integration.test.ts`                   | 12/0   | 12/0  | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/memory-mcp.integration.test.ts`                     | 0/1    | 1/0   | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/native-room-handoff.integration.test.ts`            | 4/0    | 4/0   | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/operator-seat-binding-native.integration.test.ts`   | 2/0    | 2/0   | Native/route admission proof                       |
| `apps/clankie/test/operator-seat-binding-routes.integration.test.ts`   | 9/0    | 9/0   | Native/route admission proof                       |
| `apps/clankie/test/owner-app-seat-turn.integration.test.ts`            | 11/0   | 11/0  | Existing post-admission consumer proof             |
| `apps/clankie/test/owner-update-bridge.integration.test.ts`            | 2/0    | 2/0   | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/remote-lead-fleet-wakes.integration.test.ts`        | 3/0    | 3/0   | Unchanged caller/control/denial coverage           |
| `apps/clankie/test/room-handoff-native-captain.integration.test.ts`    | 0/2    | 2/0   | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/runtime-health-native.integration.test.ts`          | 0/1    | 1/0   | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/seat-capabilities.integration.test.ts`              | 3/0    | 3/0   | Existing post-admission consumer proof             |
| `apps/clankie/test/seat-delivery-settle.integration.test.ts`           | 10/1   | 11/0  | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/seat-events.test.ts`                                | 4/3    | 7/0   | Explicit binding or neutral refusal fixture repair |
| `apps/clankie/test/seat-pump.integration.test.ts`                      | 4/0    | 4/0   | Existing post-admission consumer proof             |
| `apps/clankie/test/seat-restart-reconnect.integration.test.ts`         | 2/0    | 2/0   | Existing post-admission consumer proof             |
| `apps/clankie/test/seat-shutdown.integration.test.ts`                  | 1/0    | 1/0   | Existing post-admission consumer proof             |
| `apps/clankie/test/tracker-connected-priority.integration.test.ts`     | 0/7    | 7/0   | Stateless provider or shared consumer fixture      |
| `apps/clankie/test/work-item-write.integration.test.ts`                | 0/10   | 10/0  | Stateless provider or shared consumer fixture      |
| `apps/clankie/test/worker-bridge-concurrency.integration.test.ts`      | 2/9    | 11/0  | Stateless provider or shared consumer fixture      |
| `apps/clankie/test/worker-parent-routing.test.ts`                      | 47/0   | 48/0  | Explicit binding or neutral refusal fixture repair |
| `apps/relay/test/operator-conversations.test.ts`                       | 168/0  | 168/0 | Unchanged caller/control/denial coverage           |
| `apps/tui/test/access-cli.test.ts`                                     | 3/0    | 3/0   | Unchanged caller/control/denial coverage           |
| `apps/tui/test/doctor-fleet-link.integration.test.ts`                  | 2/0    | 2/0   | Unchanged caller/control/denial coverage           |
| `apps/tui/test/herdr-workdir-cli.test.ts`                              | 20/0   | 20/0  | Unchanged caller/control/denial coverage           |
| `apps/tui/test/install-doctor.test.ts`                                 | 24/0   | 24/0  | Unchanged caller/control/denial coverage           |
| `apps/tui/test/linear-follow-status.test.ts`                           | 1/0    | 1/0   | Unchanged caller/control/denial coverage           |
| `apps/tui/test/linear-publishing-command.test.ts`                      | 8/0    | 8/0   | Unchanged caller/control/denial coverage           |
| `apps/tui/test/linear-wake-command.test.ts`                            | 2/0    | 2/0   | Unchanged caller/control/denial coverage           |
| `apps/tui/test/mcp-bridge.test.ts`                                     | 25/0   | 25/0  | Unchanged caller/control/denial coverage           |
| `apps/tui/test/mcp-unbound-bridge.integration.test.ts`                 | 10/0   | 10/0  | Unchanged caller/control/denial coverage           |
| `apps/tui/test/owner-command-layer.test.ts`                            | 10/0   | 10/0  | Unchanged caller/control/denial coverage           |
| `apps/tui/test/setup-commands.test.ts`                                 | 7/0    | 7/0   | Unchanged caller/control/denial coverage           |
| `apps/tui/test/worker-bridge-status.integration.test.ts`               | 3/0    | 3/0   | Unchanged caller/control/denial coverage           |
| `apps/tui/test/worker-link.test.ts`                                    | 49/0   | 49/0  | Unchanged caller/control/denial coverage           |

Inspected archive: [full caller inventory, red/green results, exact GO14 failure and guard mutation proof](clankie://evidence/sha256/a36f564229598dec3a65fe2d635a947f7befccf1d67c320302c54153fc7a3b64).
