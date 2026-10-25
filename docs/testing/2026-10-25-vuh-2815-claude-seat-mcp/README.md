# VUH-2815: scoped Claude operator MCP

2026-10-25, Claude Code **2.1.310**, macOS. Built from the VUH-2815 worktree
based on `2235beb2e`. Native probes ran through `clankie heavy --`, with
`DISABLE_AUTOUPDATER=1`. The live lead seat was never restarted or relaunched.

The [native proof bundle](clankie://evidence/sha256/514a1afe91e1b96f0fa3bf43b559f188ccc61ae6ce115bf1dafeebf6bc4aa437)
contains the named JSON/text records below as entries in `native-proof.json`.
Fetch with `clankie evidence fetch docs/testing/2026-10-25-vuh-2815-claude-seat-mcp`.

## Native before / after

| Launch                              | Servers | Discovered tools | Clankie bridge tools |
| ----------------------------------- | ------: | ---------------: | -------------------: |
| Previous unscoped plugin launch     |      14 |              339 |                   82 |
| New launch, default                 |       1 |               82 |                   82 |
| New launch, `--mcp-servers blender` |       2 |              108 |                   82 |

`before.json`, `after.json` and `opt-in-blender.json` contain the complete
observed tool-name lists and server states, with configs, credentials and account
metadata removed. The bridge's 82 unqualified tool names match exactly before
and after. Its Claude namespace changes from `plugin:clankie:lead` to `clankie`.
Counts are discovered tools, including tools protected by permission rules;
unconnected servers contribute zero. The issue's approximate 182 is historical,
not the current measured total.

The old launch loaded Blender, Pixel, DaVinci Resolve, CapCut, banking, Unreal,
Linear, Expo and five claude.ai connectors (Claude Docs, Figma, Drive, Calendar,
Gmail). The new launch's complete list contains only `clankie`.
`plain-claude-mcp-list.txt` separately shows the owner's ordinary Claude still
has its configured servers and connectors; it is a health observation, not a
claim that every remote tool succeeds.

The probe used the real launch planner (`planSeat`, `--new --dry-run`), then
passed its args to installed Claude with `-p --input-format stream-json
--output-format stream-json --verbose --no-session-persistence`. It sent only
SDK `initialize` and `mcp_status` control requests and closed stdin. No user
prompt, model turn or MCP tool call was sent. `disableAllHooks: true` was added
only to avoid hook side effects. Before/after used the same authenticated owner
profile. To reconstruct the old launch, the before probe removed only strict
MCP flags and `disableClaudeAiConnectors` from the generated plan. The final
headless probes do not poll any conversation outbox.

## Contracts and configuration preservation

`contracts.txt` records checks through the real planner and real user/project/
local config files: unknown/reserved names and personal Linear refused; Claude
only; `none`; local > project > user precedence; unselected project server absent;
private config mode 0600 inside a 0700 launch directory. Opt-ins copy definitions
into the private file, never into argv or dry-run output. Existing launcher tests
passed (16/16); focused TUI typecheck passed. The required landing gate and exact
review are reported on the issue.

`owner-mcp-config-preserved.json` records equality of owner MCP definitions
against the copied baseline and byte-identical owner settings files. The whole
`.claude.json` hash changed while live sessions were running; its MCP definitions
still match. No owner configuration file was directly edited. No Claude binary,
shim or owner MCP registration was changed.

## Retained plugin, binding and isolated channel proof

`style-hooks-skills.json` records a native print-mode request from the real
launcher and plugin against an owned loopback Clankie app and deterministic
local API responder. The full Clankie output style is present as a request
message reminder, both persona and memory hook markers are present, the lead
hook guidance and `/clankie:this-machine` skill are present, and the actual tool
is `mcp__clankie__reply`. There is no explicit style override. This probe made no
external inference call. An earlier assertion looked only in the system block;
its false negative was corrected by checking the complete native request.

`channel-events.json` records a separate native TUI against that owned app,
using a new non-global conversation. All three emitted `watch`, `wake` and
`message` markers appeared in its native terminal and were acknowledged through
the source bridge. Only that conversation was polled. Native channel policy
requires normal Claude authentication/network; this mode did not intercept
inference and is not claimed to have made zero external inference calls. It was
interrupted after receipt. No live lead or real worker tools were provided.

Both runs retained `CLANKIE_SEAT_HARNESS=claude`, a seat session id and the new
conversation binding. `native-after-binding.json` rechecks all 82 tools with the
final generated declaration. `native-unbound-binding.json` shows the generated
server fails with zero tools when `CLANKIE_CONVERSATION_ID` is absent. The file
adds `--conversation ${CLANKIE_CONVERSATION_ID:-}`, so an absent value is refused
before upstream connection. This is a presence guard, not verified-seat authority.
The private bare-server file is a new convenient reusable artifact; a same-user
process can deliberately provide a binding. Direct unbound operator bridges
still default to the lead under known [VUH-2816](https://linear.app/vuhlp/issue/VUH-2816),
which is outside this patch.

The [plugin README](../../../integrations/claude-plugin/README.md#what-the-scoped-launch-retains)
lists every old-prefix reference and its disposition, including the owner rule
that was reported without editing. `prefix-audit.txt`, `owner-prefix-rules.json`
and `compatibility-tests.txt` retain the read-only inventory and focused boundary
check results (27 passed, one skipped).

## Earlier probe isolation incident

An interactive throwaway profile confirmed the explicit `server:clankie`
channel and `/mcp` showing exactly `clankie`, **82 tools**. Strict mode removes
plugin MCP, so the launcher explicitly copies `lead` as the already-supported
bare `clankie` channel; identity, hooks, skills and room-agent tool permissions
remain in the plugin.

That interactive probe mistakenly omitted a fresh conversation binding: a bare
operator bridge defaults to `global-default`, even from a throwaway profile.
It received a queued worker report, acknowledged it, sent a worker follow-up and
armed a completion watch before the throwaway seat exited. The live lead seat
was not restarted or steered. This unintended side effect was immediately
reported to Clankie (delivery `f18fe04b-f656-4d19-a8da-994117e651a5`). Subsequent
scope probes used print mode with no model turn or event polling. The shipped
seat skill now explains this isolation requirement. This incident is not claimed
as a clean isolated channel E2E.

## Documented mechanism

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference):
  `--strict-mcp-config --mcp-config` limits loaded sources. Strict mode also
  excludes plugin MCP, which is why the bridge is explicitly declared.
- [Disable claude.ai connectors](https://code.claude.com/docs/en/mcp#disable-claudeai-connectors):
  `disableClaudeAiConnectors: true`, passed with session-only `--settings`.
- [Development channels](https://code.claude.com/docs/en/channels-reference#test-during-development):
  `--dangerously-load-development-channels server:clankie`.
- [MCP policy evaluation](https://code.claude.com/docs/en/managed-mcp#how-a-server-is-evaluated):
  allowlists merge across scopes; an `allowedMcpServers` override alone is not
  exclusive, so this operator launch uses strict explicit configuration instead.
