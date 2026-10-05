# ADR 0224: Grok Build shares the visible native session

Status: proposed for review (2026-10-04; VUH-1583).

Extends [ADR 0203](0203-clankie-keeps-what-better-models-cannot-absorb.md)
and [ADR 0207](0207-work-records-and-native-agent-delivery.md).

## Context

Grok already appeared in the hire request enum and transcript reader. Neither
established a native automated delivery channel. Installed Grok Build 1.0.46
provides a leader IPC socket and ACP on the same interactive TUI session. Its
standalone agent stdio/headless modes would create a separate invisible worker.

## Decision

On macOS, allocate a visible `grok --leader` TUI with a fresh UUID and a private
socket using Herdr's initial-command layout API. Connect to that socket once;
initialize ACP, load the exact session, and deliver prompts with caller-created
prompt IDs. Never type briefs, reconnect to another leader, replay uncertain
input, or start an ACP stdio/headless agent. Pin the observed protocol and binary
to 1.0.46 until another version receives boundary and live verification.

Bind the original TUI PID, microsecond process birth, canonical executable/cwd,
terminal and Herdr session descriptor. Separately verify the leader's native
reported PID against kernel birth, executable, UID, cwd and private socket inode
and ownership. Native `active_sessions.json` must also identify that original
TUI/session/cwd; it is readiness evidence alongside kernel proof, never authority
on its own. Worker bridge admission recognizes only controller-created leaders
with that original pane proof. Saved disk records cannot adopt arbitrary leaders.

Herdr 0.9.3 can omit the top-level `agent` after `pane.report_agent`, while
returning `agent_session.agent`. Accept the nested agent only when the top-level
field is absent. When both exist they must agree. A null, contradictory, missing
source/id, changed PID, terminal or native session refuses control.

Persist a delivery fence before native dispatch. Queue membership or
`runningPromptId` acknowledges consumption; it is not model awareness. A final
native prompt result must echo the original session and prompt ID. Late evidence
reconciles the original receipt, never creates another prompt. Permissions and
questions remain in the native TUI for the owner; cancellation means submitted,
not a fabricated completion acknowledgment. Release closes the controller and
only an observed original TUI exit permits stopping its own proven leader.

`clankie seat --harness grok` uses the same native channel with a separate
Clankie workspace conversation, service persona and memory card, the real
operator MCP bank, a selected skill-path manifest, transcript upload and the
existing service outbox. Fresh launches create separate chats; resume requires
the original profile, UUID and conversation plus a confirmed prior exit. It
never changes accounts, signs in, or installs a plugin on the owner's behalf.
Worker saved-history resume is refused without a live original controller.

Grok leader mode ignores CLI permission allow/deny rules. Do not advertise
those flags as isolation. Check enabled native catalog tools before accepting
readiness; an observed enabled direct `mcp.linear.app` endpoint refuses before
the brief and names the owner's disable-and-start-fresh step. Other configured
MCP servers and permission prompts retain their native policy. Selected model
and effort must be present in Grok's native options and echo after selection;
unknown options do not silently fall back.

The shared MCP projection adds root `type: "object"` to every listed schema,
including object unions. MCP requires it. Preserve the complete original schema
and validate calls against the original bank, including union alternatives.

## Evidence and limits

The opt-in `apps/clankie/scripts/verify-grok-seat.ts` uses an actual Captain,
loopback API/MCP, public hire/message tools and public operator CLI in its own
Herdr session. It copies an explicitly supplied existing Grok login into a
temporary profile, keeps state and memory private, and verifies the live fleet
descriptor is byte-identical. Native agent replies, rather than prompt text in
a terminal, establish model awareness. Grok's public operator launch received a
real service outbox wake and identified Clankie, a private persisted memory note,
a bundled skill and `hire_agent` from its context.

The root-schema regression uses the official MCP SDK against the real Captain
loopback service, compares every schema with the original and tests invalid
arguments/union refusal. Fresh visible Claude Code and dedicated-server Codex
both completed existing read tools through that same path and reported the
returned values. Their native transcript/app-server receipts are separate from
the SDK regression. The real-shaped Herdr golden covers absent, agreeing and
contradictory agent fields, with OpenCode and Pi regression checks.

Grok automated control is macOS-only, version-pinned, and requires an existing
sign-in. Pipeline splitting remains unsupported for initial-command hires.
Selected skills are readable paths, not an asserted native plugin installation.
Native owner permission acceptance and restart/controller recovery are not
implied by catalog readiness, queue receipts or transcript discovery. The
evidence directory records the instrument failures and live results separately.
