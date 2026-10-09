# ADR 0246: Worker questions use native hook answers

Status: accepted for VUH-1782 (2026-10-07); extended for VUH-1868 (2026-10-09). Extends [fleet owner settings](0230-fleet-responsibility-is-owner-settings.md)
and [native delivery](0207-work-records-and-native-agent-delivery.md).

## Decision

Claude Code workers expose structured questions through synchronous plugin
command hooks. A `PreToolUse` hook for `AskUserQuestion` preserves the original
questions and waits for answers; its response supplies `permissionDecision:
"allow"` with `updatedInput` containing the original questions and an `answers`
object keyed by literal question text. A `PermissionRequest` hook returns a
`hookSpecificOutput.decision.behavior` of `allow` or `deny`. An asynchronous hook
cannot decide permissions, and interactive sessions ignore `defer`.

Each request and question receives a stable ID in Clankie's existing native
question path. Delivery accepts answers only through that harness channel and
by ID; it rejects IDs after resolution. The bridge translates stable IDs to
Claude's text-keyed answer object only when returning the hook response. Reject
duplicate question text within a call to avoid losing an answer during that
translation. Permission hook invocations get their own IDs because their native
input lacks `tool_use_id`. No answer is sent by typing into a Herdr pane.

The hook keeps its original session and input snapshot while it waits, bounded
by a nine-minute hook timeout. Timeout, disconnect, cancellation and stale IDs
never imply approval. Existing Claude deny rules retain precedence, and sandbox
network prompts are outside `PermissionRequest`. Other hooks and harness
permission settings may still prevent execution.

The [spike record](../verification/vuh-1782-claude-hook-spike.md) links the official
hook contracts and records static corroboration from installed Claude Code
2.1.293. That evidence supports the chosen mechanism; it does not establish that
a live interactive Claude invocation consumed an answer. Transport integration
checks and live harness acceptance are separate evidence.

## Owner gates

Four category leaves live under `autonomy.fleet`: `everydayWork`, `leavesMac`,
`hardToUndo`, and `moneyAndAccounts`. Their choices are `allow` (Just do it),
`lead` (Clankie decides), and `owner` (Ask me). Money and accounts accepts only
`owner`, globally and in project overrides. Shared wording, preset definitions,
and generated summaries belong to `@clankie/protocol` so the TUI and later app
lane describe the same policy.

| Preset             | Everyday work | Leaves your Mac | Hard to undo | Money and accounts |
| ------------------ | ------------- | --------------- | ------------ | ------------------ |
| Hands-off          | allow         | lead            | lead         | owner              |
| Balanced (default) | allow         | lead            | owner        | owner              |
| Careful            | lead          | owner           | owner        | owner              |

Presets change only these four category leaves. Existing `push` and `release`
settings remain authoritative for those actions; presets do not replace their
choices or release rules. Projects override each leaf independently; clearing
one override restores inheritance. Disk reads materialize defaults, while
transport responses leave unsupported fields absent and advertise support with
`fleetGates: true` only when every effective gate is present.

A worker question above the lead's effective gate escalates through VUH-1809's
existing ask and escalation path, preserving its question IDs and resolution
state. This adds no parallel owner-question store or new approval engine. Gates
describe who decides within existing authority; they grant no credential,
account, workspace or machine access. Harness permission settings can project
the policy conservatively where supported; they cannot authorize an action
outside those boundaries. Ambiguous shell/MCP permissions are owner-only; a
category preference cannot safely grant broad native shell permission. Remote
questions with no verified workspace policy also stay owner-only. The categories do not replace native custom rules.

## Hired Claude auto mode (2026-10-09)

James decided that hired Claude workers launch in `auto` mode. The launch
settings enable Claude's native auto classifier and contain no blanket `ask`
rules for Bash, web or file tools: explicit ask rules override auto mode and
were stopping routine work at every command. The launch allows only the
worker MCP server, never all Bash. Inherited managed denies, session tracker
denies and the plugin's permission hook remain in force. Calls that still
require permission follow the existing question and owner escalation path;
this changes neither account authority nor the fleet's decision gates.

## Lead permission answers and native relay (2026-10-09)

James assigned routine, in-scope, non-gated permission decisions to the lead;
owner-only decisions stay with James. The implementing lead chose the full
`PermissionRequest` hook as the primary transport because it supplies the full
`tool_input`. Only the worker's exact private authenticated lead may answer,
with current ownership, occupant and policy checked again before dispatch.
Peers, rooms and Discord cannot answer. Scoped non-sensitive file operations,
`pwd` and literal `git status` are routine candidates; web tools follow the
leaves-Mac gate. Ambiguous shell/MCP calls, recursive searches, sensitive files,
symlink escapes and unverified remote workspaces require the owner.

The implementing lead also chose to support Claude's native channel permission
relay as an owner-only fallback. Its documented `description` and `input_preview`
are display data: the latter is sanitized, folded and truncated. They cannot
prove a full command safe for the lead. The bridge declares
`experimental["claude/channel/permission"] = {}` only on an opted-in linked
channel; exact four-string permission requests become typed native questions.
Only an authenticated owner verdict returns the exact request ID and behavior.
Ordinary chat answers never become verdicts. Native first-answer arbitration
has no application receipt, so a channel stdout write stays unconfirmed and is
never retried. See the [official channel contract](https://code.claude.com/docs/en/channels-reference).

Every valid permission decision records request, pane/session, input hash,
allow/deny and who decided (lead conversation, authenticated owner principal,
or system denial reason) before delivery. The atomic owner-private journal
records pipe delivery separately. Audit failure refuses approval. No new
credential or account authority is granted. Focused boundary and live evidence
is recorded in [VUH-1868 verification](../verification/vuh-1868-claude-workers.md).

## Consequences

Transport checks exercise the real command hook over HTTP and acknowledge its
stdout write; that receipt proves the pipe write, not Claude model awareness.
Owner asks canceled through the inbox leave the native hook waiting until its
native resolution or nine-minute expiry. Unrelated parallel tool completions
do not cancel another pending question.

Workers can resolve supported native questions without keystrokes, while the
owner remains responsible for money and accounts. A lost or expired answer
leaves work visibly blocked instead of silently granting permission. The public
core owns hooks, protocol and fleet settings; app rendering and World visit
animation remain a later lane. This decision authorizes no deployment, restart,
or steering of an existing worker session.
