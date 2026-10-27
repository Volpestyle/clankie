# VUH-2816: joined worker projection and complete MCP consumer audit

The consumed GO17 landing gate failed on the unchanged approved source at
`fe3ffbbdfa303ddcd42f1a46ad9c0d580c2a52f5`, base
`4fff51a2b29f1d0ff0087554d06ea3b24cb6e433`. Its exact JSON/log/driver and
remote readback are retained. No retry, waiver, revalidation or push followed.
The joined-hire test timed out with an unhandled pre-connect missing-conversation
refusal. Wren's old90784b77 source approval remains preserved and does not approve
this repair. GLOBAL18/19 require a fresh Quill review and separate landing GO.

## Production trace and repair

`joinedWorkerPorts` already puts the launch conversation into the new worker
pane environment and verifies it against the home launch token. Claude inherits
that environment. Codex passes only named MCP environment variables; its
`CODEX_BRIDGE_ENV` omitted `CLANKIE_CONVERSATION_ID`. The joined worker wrapper
starts `clankie mcp --seat`; `runJoinedSeatHook` selects the existing joined
operator-shaped projection. The bridge's local guard refused the missing ID
before any request reached the tunnel. This was a real Codex joined-worker
regression, faithfully reproduced by the fixture's actual env filtering.

The entire production repair is one allowlist entry. It projects the existing
launch ID without fabricating a default or weakening the operator guard.
`joinedSeatTransport` remaps MCP/events onto fleet routes, replaces authorization
with the joined token, and verifies the native pane/session before every request.
The home token binding independently selects the worker-only bank (empty captain
base bank) and worker outbox. A mismatched query ID gets403
`remote_lead_conversation_mismatch`. Workers do not receive the lead bank.

The joined-hire regression now pins the projected variable, rejects an unrelated
conversation at the real home route, checks each lead tool is absent, and sends
the worker report successfully. Removing only this allowlist entry through an
ignored Vite transform fails the regression; tracked bytes never change.

## Complete inventory and full-suite outcome

The archive records production spawners, aliases, generated configs, joined
rewrites, remote-lead remapping, relay exclusions, and test/helper chains. Search
patterns and non-spawner classifications are included. It follows launcher
wrappers as well as direct HTTP and command calls. The earlier48 HTTP caller
inventory was insufficient; it did not include the joined hook or all indirect
launcher-hosted pumps.

The full apps/clankie and apps/tui suites ran with821 named files, no bail,
normal config exclusions/opt-in skips unchanged. Two computer-body exclusions
leave819 included files. Result: **6613passed,1failed,103skipped** across6717tests;
782passed files,1failed,36skipped. Source hashes stayed fixed throughout the
1167.698-second run. It is a failing full run, not a green gate or waiver.

The complete runtime failure list has one entry:
`opencode-seat-resilience.integration.test.ts:219`, timed out waiting for seat
delivery after its stalled context read, before provider recovery assertions.
The fixture supplied no binding registry or HTTP socket context and ignored the
new fifth spawn callback, so real launch registration never ran. Its test-only
repair injects the real registry with controlled kernel observations, forwards
actual owned HTTP sockets as the launcher-hosted pump, and invokes production
`onSpawn(actualNativePid)` so the actual PUT/nonce path registers the spawned
child. Birth observations last only that child lifetime. No fabricated bridge,
claim-derived identity, provider production code, assertion or deadline change.
These observations are stand-ins, not native process acceptance.

The inventory also found `room-turn-cause.integration.test.ts`'s actual CLI
bridge lacked a binding/nonce. It now registers through real PUT, forwards its
owned HTTP socket, and gives only the bridge a0600 nonce file. Its original
refusal-cause assertion and deadline are retained. The shared fixture nonce now
uses32randomBytes as64hex to match the actual CLI's file reader. TUI typechecking
caught an invalid transitive type import; using the actual incoming/outgoing
Node HTTP objects fixes that fixture without adding a dependency.

## Acceptance boundaries

No root gate, rebase, revalidation or push ran for this repair. GLOBAL owns the
landing window, deployment, installed/original operator acceptance and closure.
Real ClaudeN shell topology, Codex shim/native, OpenCode/Grok config/parentage,
and Prime's verified kernel PID/lifetime/launch edge remain open. Prime's existing
operator launcher is explicitly inventoried; no bearer fallback was added to
paper over that native interface gap. Joined worker proof uses an isolated
fixture and token-bound home routes, not an owner/model harness launch.
The OpenCode resilience case runs its existing isolated native binary against
a controlled local provider; it does not establish installed owner acceptance.

Original import cb6c107343de02625eee7d214b70b15e0a22f899, base
83b157cfcfe946dc3af600472cb482a687b39a43, net SHA256
3373be6f63fa384a8b239a334cbaee2f4007f956036f8fe85aee03e66d4f0844,
all old CHANGES/approvals and every failed gate remain retained. Registry and
nonce-enforcement bytes are unchanged; their earlier mutation proof remains
valid. Wren's nonblocking exact neutral tool-name-list test stays a future
landing-comment follow-up; it was not added to this repair.

## Final focused verification

After enumerating the one full-suite failure, only the OpenCode resilience
fixture and the room-turn fixture type were corrected. All other full-run
source inputs remain unchanged. The final affected consumer set passes
**51files598/598tests, zero skipped**, including the repaired resilience case,
the joined worker case, actual CLI case, and both native binding cases.
The retained full no-bail run remains **6613pass/1fail/103skip**; it is not
relabelled as an all-green full suite. Final focused proof supplements that
complete result for the changed fixtures.

Both app typechecks, scoped lint/format and swallowed-rejection preflight are
recorded separately with exact commands and source hashes. Controlled native
fixture observations do not replace the carried installed/real-wrapper gaps.

## Production spawner inventory

The complete records and search/exclusion evidence are in the archive. Entries
include command dispatchers and wrappers so multiline and indirect calls remain
visible. The table is source inspection, not a claim that each harness ran.

| Source                                                    | Kind                       | Authority                                                                        |
| --------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `apps/tui/bin/headless-captain.ts:64`                     | dispatcher                 | caller authority                                                                 |
| `apps/tui/src/command/joined-seat.ts:234`                 | joined operator projection | delegated joined lead/worker bank; verifyJoinedWorker before tunnel calls        |
| `apps/tui/src/command/joined-worker.ts:149`               | joined worker wrapper      | joined worker delegated session grant                                            |
| `apps/tui/src/command/joined-seat.ts:84`                  | joined Claude launcher     | joined lead delegated bank                                                       |
| `integrations/claude-plugin/.mcp.json:5`                  | operator declaration       | native operator harness                                                          |
| `integrations/codex-plugin/.mcp.json:5`                   | operator declaration       | native operator harness                                                          |
| `apps/tui/src/command/claude-seat-mcp.ts:70`              | operator config builder    | native operator harness                                                          |
| `apps/tui/src/command/seat.ts:478`                        | Claude launcher            | native operator binding                                                          |
| `apps/tui/src/command/codex-seat.ts:231`                  | operator launcher          | native operator binding                                                          |
| `apps/tui/src/command/opencode-seat.ts:437`               | operator launcher          | native operator binding                                                          |
| `integrations/opencode-plugin/plugin.mjs:178`             | operator config wrapper    | native operator binding                                                          |
| `apps/tui/src/command/grok-seat.ts:250`                   | operator ACP launcher      | native operator binding                                                          |
| `apps/tui/src/command/prime-seat.ts:229`                  | operator daemon launcher   | resident Prime operator; missing local binding compatibility requires assessment |
| `integrations/claude-plugin/worker/.mcp.json:5`           | worker declaration         | fleet mailbox or joined projection                                               |
| `integrations/claude-plugin/worker/bin/swarm-mcp.mjs:34`  | worker alias/wrapper       | worker mailbox; joined hook changes transport/projection                         |
| `integrations/claude-plugin/worker/codex-mcp.json:5`      | worker declaration         | owner-granted fleet tools                                                        |
| `integrations/claude-plugin/worker/bin/fleet-mcp.mjs:5`   | worker implementation      | owner-granted fleet tools; no operator fallback                                  |
| `apps/tui/src/command/mcp.ts:1348`                        | CLI fleet alias            | fleet process proof / individual grant / operator separate branches              |
| `integrations/opencode-plugin/worker-server.mjs:18`       | worker config              | fleet tools                                                                      |
| `apps/clankie/src/captain/pi-worker-fleet.mjs:176`        | Pi worker subprocess       | fleet tools; integration/pi-plugin/worker.mjs:59 creates consumer                |
| `apps/clankie/src/captain/grok-seat-adapter.ts:237`       | Grok worker ACP            | fleet tools                                                                      |
| `apps/clankie/src/captain/prime-seat-adapter.ts:235`      | Prime worker daemon        | fleet tools                                                                      |
| `apps/clankie/src/captain/codex-seat-adapter.ts:345`      | Codex worker config alias  | fleet tools                                                                      |
| `apps/clankie/src/captain/codex-catalog-refresh.ts:11`    | legacy worker declaration  | fleet tools                                                                      |
| `apps/clankie/src/remote-project-leads.ts:114`            | remote lead config         | fleet lead delegation                                                            |
| `apps/tui/bin/remote-lead-mcp.ts:153`                     | remote lead wrapper        | authenticated fleet lead routes                                                  |
| `integrations/remote-lead/bootstrap.mjs:88`               | remote lead launcher       | fleet lead delegation                                                            |
| `apps/clankie/src/captain/remote-codex-app-server.ts:324` | remote worker wrapper      | fleet tools via deployed bridge                                                  |
| `apps/clankie/src/windows-codex-launch.ts:193`            | Windows worker wrapper     | fleet tools via deployed bridge                                                  |

## Test command and helper chains

The archive classifies111 matching test/helper files, including non-spawners,
diagnostic data, config-only mocks and direct HTTP consumers. Actual command,
stdio, native-config and indirect-pump records are listed here. Permissive
HTTP fixtures prove transport behavior after admission, never kernel proof.

| Source                                                              | Kind                                                   | Conversation / lane                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `apps/clankie/test/seat-capabilities.integration.test.ts`           | actual command/parser invocation or stdio/helper chain | operator/global-default; mode legacy or current                                                    |
| `apps/clankie/test/seat-shutdown.integration.test.ts`               | actual command/parser invocation or stdio/helper chain | operator/global-default                                                                            |
| `apps/clankie/test/linux-native-fleet-docker.integration.test.ts`   | actual helper chain                                    | fleet; inherited owned native Pi pane                                                              |
| `apps/clankie/test/joined-hire.integration.test.ts`                 | actual command/parser invocation or stdio/helper chain | joined worker; conversation absent in literal args; joined env/session/token                       |
| `apps/clankie/test/opencode-seat-resilience.integration.test.ts`    | actual indirect operator upstream/pump consumer        | operator; selected conversation from launcher context; plugin clankie MCP shell shim remains exit1 |
| `apps/clankie/test/local-codex-catalog-native.integration.test.ts`  | actual native harness config consumer                  | fleet; no operator conversation                                                                    |
| `apps/clankie/test/tracker-connected-priority.integration.test.ts`  | actual command/parser invocation or stdio/helper chain | operator provider plus operator bridge                                                             |
| `apps/clankie/test/seat-restart-reconnect.integration.test.ts`      | actual command/parser invocation or stdio/helper chain | operator/global-default                                                                            |
| `apps/clankie/test/seat-pump.integration.test.ts`                   | actual command/parser invocation or stdio/helper chain | operator/global-default                                                                            |
| `apps/clankie/test/linear-connected-receipts-integration.test.ts`   | actual command/parser invocation or stdio/helper chain | operator provider plus operator bridge                                                             |
| `apps/clankie/test/project-proof-frequency.integration.test.ts`     | actual helper chain                                    | fleet; pane from helper args; no operator conversation                                             |
| `apps/clankie/test/mcp-receipts-integration.test.ts`                | actual command/parser invocation or stdio/helper chain | operator; JSON binding file when passed                                                            |
| `apps/clankie/test/owner-update-bridge.integration.test.ts`         | actual command/parser invocation or stdio/helper chain | operator; binding conversation from binding JSON when passed                                       |
| `apps/clankie/test/fixtures/mcp-stdio-bridge.ts`                    | actual command/parser invocation or stdio/helper chain | operator; binding.conversationId optional                                                          |
| `apps/clankie/test/fixtures/operator-seat-binding-native-mcp.ts`    | actual command/parser invocation or stdio/helper chain | operator/native-seat                                                                               |
| `apps/clankie/test/fixtures/seat-pump-stdio.ts`                     | actual command/parser invocation or stdio/helper chain | operator/global-default                                                                            |
| `apps/clankie/test/fixtures/operator-seat-binding-native.mjs`       | actual command/parser invocation or stdio/helper chain | operator/native-seat                                                                               |
| `apps/clankie/test/fixtures/linear-connected-mcp.ts`                | actual command/parser invocation or stdio/helper chain | operator; bindingPath supplied by fixture when configured                                          |
| `apps/tui/test/room-turn-cause.integration.test.ts`                 | actual command/parser invocation or stdio/helper chain | operator/global-default                                                                            |
| `apps/tui/test/claude-plugin.test.ts`                               | actual command/parser invocation or stdio/helper chain | operator config or fleet wrapper                                                                   |
| `apps/tui/test/mcp-unbound-bridge.integration.test.ts`              | actual command/parser invocation or stdio/helper chain | operator; absent or workspace-7 env                                                                |
| `apps/tui/test/access-cli.test.ts`                                  | actual command/parser invocation or stdio/helper chain | invalid obsolete args                                                                              |
| `apps/tui/test/mcp-bridge.test.ts`                                  | actual command/parser invocation or stdio/helper chain | operator (none or env project-a); fleet seat                                                       |
| `apps/tui/test/worker-link.test.ts`                                 | actual command/parser invocation or stdio/helper chain | fleet mailbox/worker, pane w8:p3                                                                   |
| `apps/tui/test/peer-receipt.test.ts`                                | actual stdio spawn                                     | fleet; pane w1:p1; no operator conversation                                                        |
| `apps/clankie/test/linear-request-budget.integration.test.ts`       | actual command/parser invocation or stdio/helper chain | operator provider plus operator bridge                                                             |
| `apps/clankie/test/helpers/project-native-proof/bridge-harness.mjs` | actual fleet helper chain                              | fleet; no operator conversation; node [fleet-mcp.mjs]                                              |
| `apps/clankie/test/fixtures/linux-native-fleet/pi-extension.mjs`    | actual fleet helper chain                              | fleet; no operator conversation; node [fleet-mcp.mjs]                                              |
| `apps/clankie/test/fixtures/linux-native-fleet/journey.ts`          | actual fleet helper chain                              | fleet; no operator conversation; node [fleet-mcp.mjs]                                              |

Final package typechecks pass for both apps (service source plus15 test partitions; TUI source plus4 partitions). Scoped lint/format, swallowed-rejection preflight and935doc links pass.

Inspected archive: [complete spawner inventory, full red matrix, final affected green proof and both app typechecks](clankie://evidence/sha256/c0dabe37a4982fdf95d05255ffcbd74401939deffae0af8546b5bfeba52476ff).
