# VUH-1678: Linear webhook wakes in an ordinary chat

This is James's live check after the integrated build is running. Development
checks use disposable service state; this document does not establish live
webhook delivery. Keep results on
[VUH-1678](https://linear.app/vuhlp/issue/VUH-1678).

## Read the current setup

Run these read-only commands through the existing owner-authorized CLI:

```sh
clankie linear status
clankie linear target show
clankie linear wake show
clankie conversations list
```

Expected defaults: `wakeConversationId` is `global-default`; `actors` is
`["owner"]`; `ownerUserEmails` includes `volpestyle@gmail.com`; the included types
are issue/project-update/initiative-update/document comments and mentions.
`following: true` and `active: true` are needed for the wake checks. If the target,
rules or readiness differ, record them as the test's preconditions. Explicit
installed lists are preserved: `notificationTypes: []` allows all types, so a
non-comment change by a matching owner can wake under that setting. Evaluate
passive-event checks against the rules actually returned; narrower defaults do
not overwrite explicit choices on upgrade. A blocked
webhook prerequisite needs James's existing setup flow; do not change webhook
configuration or accounts as part of this check. Production wakes also require
the connected Linear account identity in the signed event's workspace. Local
`active` readiness proves configured prerequisites, not a successful account
lookup. Decisions `identity_unavailable` or `account_workspace_mismatch` mean
passive delivery; record that connection/identity gap without changing accounts.

Open the configured chat with `clankie --chat CONVERSATION_ID`. Capture its
current end cursor and model-turn state with `clankie conversations show
CONVERSATION_ID --limit 20`. Observe new events in another terminal with:

```sh
clankie conversations tail CONVERSATION_ID
```

The service's existing `~/.local/state/clankie/clankie.log` contains metadata-only
Linear decision records named `linear webhook accepted` or `linear webhook
ignored`, with `eventId`, `deliveryId`, resource `type`/`action`, `issueId` where
available, `target`, `ingested`, and `decision`. Accepted decisions include
`wake`, `deduped`, `own_actor`, `own_worker`, `follow_off`, `rule_miss`,
`identity_unavailable`, `account_workspace_mismatch`, and `target_unavailable`;
exact own-write echoes use ignored decision `self_echo`. A missing target is a
destination gap to record; it must not silently select another conversation.

```sh
tail -n 200 ~/.local/state/clankie/clankie.log | rg 'linear webhook (accepted|ignored)|Retired Linear'
```

Preserve relevant bounded lines with timestamps; an accepted decision of `wake`
means eligible chat admission, and still needs the observed model turn below.
A webhook HTTP 200 alone does not prove a model wake. Do not copy bearers,
signing secrets or raw credential files into evidence.

## A real human comment and a burst

1. As James in the existing signed-in Linear session, comment on VUH-1678 with
   a unique marker, for example `VUH-1678 live wake 2026-10-05 A`. The existing
   webhook delivers the signed POST; no handcrafted secret-bearing request is
   needed.
2. Confirm one incoming compact event in the selected ordinary chat and one
   wake/model turn. It must identify VUH-1678, its title, the comment change,
   James, and its Linear link. With the default target, this is `global-default`.
   Save the event cursor, decision log line, wake/turn event, and comment link.
   Comment hooks may omit the title; retained signed Issue context or a connected
   `get_issue` lookup bounded to one second supplies display context. If that read
   fails, the event must say `Title unavailable` and retain its signed issue
   UUID/link. Record the title-context gap; otherwise eligible activity must
   still be delivered and wake. Fetched titles never establish actor authority.
3. Prepare two marked comments and submit them so their webhook arrivals fall
   within 1.5 seconds of the first arrival. Confirm both compact events appear in
   history and one coalesced wake contains both. Record webhook arrival times and
   the wake count; arrivals outside that window do not establish a burst failure.
4. As James, insert a fresh Linear issue/profile reference in a comment or issue
   description. Mention classification uses newly added Linear links in signed
   body/description/content changes. Record its classification and wake. If the live
   payload differs from this supported form, keep it as a stated coverage gap;
   the human comment path remains the required signed-POST check.

## Own writes and other passive activity

1. From the existing Clankie conversation, ask him to publish a marked comment
   on VUH-1678 through his connected Linear tool. Verify the comment link and
   signed webhook decision record. There must be no event-triggered follow-up
   wake for his own write. The owner-requested publishing turn itself is not a
   webhook wake. Exact receipt echoes may be suppressed before chat history.
2. With the default rules, make a routine non-comment issue change as James,
   such as updating the issue description with a test marker. Confirm the
   accepted compact event is visible in the selected chat and has a no-wake
   decision. Restore the test text through Linear after recording evidence.
3. If an already-authorized other human can comment, confirm that comment is
   visible without waking under the default owner-only rules. Do not sign into
   another account to manufacture this check.

## Normal chat, settings and migration

The settings reads above prove the default destination and rules. The normal
chat picker/history must open that destination with ordinary conversation
controls. No separate inbox read/ack/handoff action should be needed.

If James also wants to verify a dedicated Linear chat, create an ordinary chat
with `/new`, name it Linear, obtain its ID with `clankie conversations list`, then
use `clankie linear target set ID`. Verify with `linear target show`, repeat the
human comment check, and restore the previous target afterward. This optional
setting change is James's live check; it does not alter the webhook subscription.
Clankie can change the same non-secret rules/target through `linear_wake`.

On an upgraded install that had legacy state, the service logs exactly:

```text
Retired Linear inbox: dropped N unread event(s); removed legacy conversation state.
Retired Linear issue routing state.
Retired Linear notification inbox checkpoint; previous account notification history dropped.
```

The first line reports the discarded unread count; each line appears only if
its legacy state existed. These migration lines should occur once.
Existing unread backlog must not become a new wake. Check the service's log and
conversation list; do not edit live state files or force a restart for this check.
Fresh installs have no legacy state and therefore cannot prove migration live.

Report the tested build SHA, setup/rules/target, comment links, bounded log lines,
conversation cursors, actual wake counts, and any omitted checks. Distinguish
HTTP acceptance, stored chat visibility, and the observed model turn.
