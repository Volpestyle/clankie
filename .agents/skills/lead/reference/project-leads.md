# Project leads

Mechanics behind [lead](../SKILL.md)'s "Other leads and panes": launching,
recovering and reaching project lead chats. Exact flags and receipts are in
[the CLI reference](../../../../docs/cli.md#conversations-lead-prepare-fleet--launch---json-stdin--revoke-id).

## Launch

A project lead is Clankie in a named workspace conversation with its own native
head, not a worker sub-lead. Its hires, reports and watches belong to that chat.
Local heads use `clankie claude --conversation ID` or `clankie codex --conversation ID`.
For a new Windows Claude head on an already-linked fleet, the owner CLI offers
`clankie conversations lead prepare FLEET`, `launch --json-stdin`, and
`revoke DELEGATION_ID`. Remote Codex heads are not yet supported.

Remote heads use a seat/chat/machine-bound, revocable delegation and require the
machine's current `workers` ceiling and approved working directory. Workspace
grants can change while a lead stays connected; its own working directory must
remain granted on every request. Launch allows the session's delegated lead MCP
tools, including `message_seat`, in auto mode independently of maximum trust;
other harness permissions remain subject to the selected profile and mode.

## Accounts

Launch may name `account` using the stable identity key (`label`/`accountKey`)
from `worker_accounts --fleet`. Discovery groups homes signed into the same
account; cards show the signed-in name or email. Existing profile aliases stay
bound to their original identity after a home re-signs. Saved preferences, holds
and usage follow the identity. A hire or remote lead picks a current home signed
into that identity and verifies it before launch; an absent or changed identity
refuses with a sign-in prompt. Never create a profile, copy credentials or
substitute another account. A deliberate relaunch into the same conversation,
fleet and workspace reuses its recorded identity when `account` is omitted;
a fresh launch chooses a usable, unheld identity from the account list.

## Link failures and recovery

A remote lead reports any fleet-link or delegation failure to the Mac lead or
owner, including the specific refusal and recovery instruction. A changed
binding or revoked workspace needs a fresh launch from the Mac after approval
is restored. Never work around a link failure by driving the Mac desktop or
rotating credentials.

Remote bridges retry temporary transport and native-proof loss. Restart recovery
requires the original pane, shell/harness lifetime, native session and chat;
explicit revocation is permanent. A launch that never proved its native process
before shutdown stops with one clear fresh-launch reason. Doctor lists known
bridges by lead chat name, including disconnected and reconnecting channels.
Never relaunch or choose another pane as reconnection. `clankie status` shows
`reconnecting` then `current` when polling resumes. Verify live tool/channel
recovery after a deploy; fixture proof alone cannot establish the remote outcome.

Keep the original request ID after uncertain launch; rereading it never launches
again. `dispatched` is not tool readiness. Prove the native lead toolkit and child
report routing before treating a project as converted. Existing workers need a
written context handoff and separately coordinated adoption; never restart their
active work as part of a new lead launch.

## Finding and reaching siblings

The private operator session card and `get_self_state.leadChats` show the global
lead and configured project leads: project, conversation, workspace, machine,
native holder or service lane, receiver state and recent activity. Use the
row's `messageSeat` conversation ID to reach a sibling without searching all
conversations. `messageAvailable` means its current receiver supports the lead
channel; a saved activity timestamp alone never means it is connected.
Disconnected, reconnecting and stale native heads remain labelled honestly.
Worker and Discord room chats stay out of this private roster; Discord cannot
read it. The card refreshes each service turn, and `get_self_state` rereads it.
Paired owner devices read the same projection; the contract is in `docs/cli.md`.

Leads talk to each other with `message_seat`, naming the other lead's
conversation ID or its head's seat ID. The message arrives in that chat over the
head's own channel as an attributed `source="lead"` event: context, never an
owner turn, and it never adopts the head as a hire. `delivered` means that
channel acknowledged it; `undelivered` means the head has no live channel, and
nothing was queued. Answer a lead message the same way, naming the conversation
it came from ([lead messages](fleet-tools.md#lead-messages-without-a-native-channel)).
Never type into a lead's pane.

## Tracker fence for remote heads

Remote project heads reach only their registered tracker project through the
seat-bound bridge. Use `mcp_tool_search` for its supported tracker tools; both
direct and deferred calls enforce the same project fence. Lists default to that
project. Reads/writes of another project's issues, moves out of the project and
cross-project relations refuse. Comment edits/replies need the explicit scoped
issue/project/status-update target as well as their comment ID. `get_user` accepts
`me` only. A missing/conflicting binding needs the owner's project configuration;
do not substitute an inherited tracker connector or `repo` override. Expanded
issue relations/releases and tools without a safe project policy are unavailable.
