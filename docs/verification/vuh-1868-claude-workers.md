# Claude worker permissions: VUH-1868

## Hired auto mode — 2026-10-09

James decided that hired Claude workers use `auto` mode without blanket ask
rules. Launch settings preserve tracker denies and enable only the worker MCP
server; they do not allow all Bash. Managed policy and plugin permission hooks
are unchanged. [ADR 0246](../adr/0246-worker-questions-use-native-hook-answers.md)
records the decision.

Checked in the task worktree based on `f545f88d`:

- `pnpm exec vitest run apps/clankie/test/claude-worker-seat.test.ts
apps/clankie/test/remote-claude-isolation.test.ts
apps/clankie/test/claude-hook-questions.integration.test.ts
apps/clankie/test/claude-hook-command.integration.test.ts`: **4 files, 80 tests
  passed**. Launch assertions cover auto mode with and without gate settings,
  no blanket ask or Bash allow, tracker denies and exact session resume. Real
  command-hook checks cover allow/deny, HTTP and stdout acknowledgment;
  registry checks cover wrong sessions, duplicate answers, expiry and cancellation.
- `clankie heavy -- zsh -c 'pnpm install --frozen-lockfile && pnpm --filter
@clankie/clankie typecheck'`: **passed**.
- Scoped `oxfmt`, `oxlint --deny-warnings` and `git diff --check`: **passed**.

These are launch and transport checks, not live Claude model acceptance.
No deployment, PC input, account changes or existing-pane steering occurred.

## Lead permission authority (2026-10-09)

James assigned routine, in-scope, non-gated decisions to the lead and retained
owner-only decisions. The implementing lead selected the full synchronous
PermissionRequest hook as primary; its complete tool input permits bounded
scope checks. The [official channel relay](https://code.claude.com/docs/en/channels-reference)
was read before implementation. Its native `description` and `input_preview`
are display data, with sanitization and per-field truncation. The native relay
is supported as an owner-only fallback, not an authority upgrade.

An opted-in linked bridge declares `experimental["claude/channel/permission"] = {}`.
Only `notifications/claude/channel/permission_request` with exactly the four
string fields `request_id`, `tool_name`, `description`, `input_preview` is
accepted. The request ID is five lowercase letters excluding `l`. An
authenticated owner verdict emits `notifications/claude/channel/permission`
with the same request ID and `behavior: "allow" | "deny"`; ordinary chat is never
parsed as approval. Claude's native first-answer arbitration gives no receipt,
so the channel verdict stays unconfirmed after its pipe write. Trust and MCP
consent prompts do not relay. The [hook contract](https://code.claude.com/docs/en/hooks)
provides the full primary input and allow/deny output.

The real registry/native adapter/ownership integration tests cover exact lead,
peer, room, Discord, revoked authority, replaced occupant, owner principal,
destructive/account/chained shell calls, protected/outside files, recursive
search, symlink escape, dangling/credential symlinks and a file replaced by a
symlink while waiting. They also cover audit persistence refusal, explicit
system cancellation and bounded-input denial. The subprocess/HTTP relay tests
cover exact native wire shapes, malformed/chat requests, consent off,
membership revocation, duplicate IDs and mismatched verdict IDs. Existing
owner-question route tests cover authenticated operator/device scope.

Checks: six focused files, 48 tests passed; scoped lint passed. Permission audits
are atomic owner-private `claude-worker-question-claims.json.decisions.json`
records beside the replay claims. They record input hashes and authenticated
lead conversations, owner principals or system-denial reasons before delivery,
with `decided`, `hook-written` and `channel-written` evidence kept separate.

### Native permission proof

At 02:42 UTC on 2026-10-09, an interactive Claude Code 2.1.295 in the lead's
throwaway Mac pane `w47:pG` received a channel brief and called Read for one
harmless file. Session `cc2deac4-bc1d-464c-a96a-dc5dbe2cac80` was verified by
its actual SessionStart hook. The PermissionRequest hook held invocation
`claude-hook:c4709f8f52bb3fcdaa475abfab9683246a53fdd2191fb3896ad1c940512e5ca4`.
An authenticated operator MCP `message_seat` answer produced `behavior: allow`,
returned `delivered/responded`, and recorded lead `global-default` with
`hook-written` audit evidence. Claude's TUI displayed “Allowed by
PermissionRequest hook” and read/replied with `VUH1868_PERMISSION_ALLOWED`.

This used the checkout's real hook, channel bridge, registry, native adapter,
ownership store and authenticated MCP route over an isolated loopback service.
The tool bank/domain wiring and Herdr observation were proof fixtures bound to
the owned child PID and its explicit native session ID; this did not deploy or
replace the installed captain. Native relay wire/owner boundaries were checked
by real subprocess/HTTP integration; native relay application remains
unconfirmed by contract. Raw local evidence is retained under
`.local/claude-proof/permission-runtime/` (`evidence.jsonl`, `native-read.txt`,
`used.json.decisions.json`). The own native child was stopped after proof.
James's panes, the PC, and dotfiles were untouched.

Heavy service typecheck passed. No full suite, build, eval or deployment ran.

The non-private lead forwarding case also escalates without publishing the full
permission payload. The linked-channel ACK regression cases pass with the relay
capability enabled. Final scoped formatting, lint and local doc-link checks pass.
