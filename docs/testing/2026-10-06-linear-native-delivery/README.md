# Linear activity reached the chat, but its native receiver was unavailable

Read-only investigation for [VUH-1743](https://linear.app/vuhlp/issue/VUH-1743/jamess-linear-comments-dont-wake-the-claude-operator-seat),
2026-10-06. Source base: `2acffdcf`. Branch: `ash/vuh-1743-linear-wakes`.

Both reported comments passed signature validation, matched the owner wake rules,
and entered `global-default` as External activity. Their subsequent turns failed
before native delivery. Zero webhook entries in the domain journal was an
incorrect diagnostic: webhook acceptance receipts live in the service log.

Follow-up branch `ash/vuh-1743-delivery-followup` covers interrupted delivery
checkpoints and the nested reaction parent identified during review. Linear's
[published SDK schema](https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql)
defines `ReactionWebhookPayload.comment` as `CommentChildWebhookPayload`, with
`issueId` and `userId`. The signed nested issue UUID now participates in the
same consistency check as top-level `issueId` and `issue.id`. Contradictory
UUIDs supply no lookup authority.

The owned HTTP regression removes the reaction fixture's inherited outer issue,
then checks that nested `comment.issueId` drives an actual context lookup and
retains the issue UUID, identifier and title. A contradictory-parent case makes
no lookup. This is schema-grounded mapping proof; receipt of an actual live
Reaction webhook and its Linear-side subscription are still unproved. No app
settings were changed. To enable that resource if absent, an administrator must
add `Reaction` to the existing webhook's selected resource types, retaining the
same URL and signing secret; `Issue` is required for assignment/delegation.

The nested-parent regression fails on the initial `2d23a90e` source (no signed
issue UUID reaches context enrichment). Raw mapping evidence:
`.local/evidence/vuh-1743/reaction-red-base.txt` and `reaction-green.txt`.

## Interrupted native takes

The production runner awaits native delivery, then checks the service shutdown
signal before publishing its final delivery receipt. Shutdown after a native
take can therefore reach the generic error path without a definite receipt.
Public conversation cancellation can finish with an uncertain receipt. Both
paths rewound the offered Linear cursor. A fresh owner comment could then
re-offer the original taken comment under a new native event ID, even after
the original exact late ACK had reconciled it.

Startup also rewound a persisted checkpoint unless a completed turn had been
saved. The owned test captures the real metadata and journal immediately after
the native HTTP take, then reloads those pre-settlement files. That crash
checkpoint has no terminal event proving that delivery was unavailable.

The correction retains the offered cursor in all three cases. Only a definite
`unavailable` receipt permits rollback. External history remains available for
inspection. This preserves uncertainty across cancellation, shutdown and
restart without replaying an original under a new event ID.

The owned tests call the actual shutdown controller and public cancellation
method after a native HTTP take, reconcile its exact late ACK, reload the
persisted store and send a fresh signed comment. The next wake contains only
the fresh comment. Both cases fail on unchanged `2d23a90e`; the pre-settlement
crash-checkpoint reload also fails there. The normal resolved-uncertainty case
already passed unchanged `2d23a90e`, so no normal-path defect is claimed.
Raw logs: `cursor-stop-red.txt`, `cursor-crash-red.txt` and `followup-green.txt`
under `.local/evidence/vuh-1743/`.

The separate checked [pump repair evidence](https://github.com/Volpestyle/clankie/blob/d321e4dd3bfa5a504e8037009e7b15c3caf0f239/docs/testing/2026-10-06-seat-pump/README.md)
records the loaded-source provenance, bounded ACK recovery, durable content-free
diagnostics and real HTTP/stdio tests. It does not establish the original
operator's exact triggering error or actual Claude consumption.

## Live evidence

Read `~/.local/state/clankie/clankie.log` and
`~/.clankie/captain/conversations/global-default/events.jsonl`; join
`linear.webhook.eventId` to `message.linear.eventId`, then the following turn.

| Comment                        | Accepted signed webhook                                        | External cursor               | Failed turn                                               |
| ------------------------------ | -------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| VUH-1538, `093e4ffb`           | 13:11:23.382Z, delivery `656cc4a0-cfbe-47b6-8fc8-cff2f79d7c57` | `000000034525`, 13:11:23.380Z | `run-3d7fafe5-bfaf-47cd-82a3-c56fc54a4ffa`, 13:11:24.918Z |
| KH2 project update, `3a338e1e` | 13:12:14.162Z, delivery `aa040761-2498-4bb7-82ce-2f53bcd9c3b3` | `000000034531`, 13:12:14.159Z | `run-7e6ecf8b-d8c9-4ffe-917c-14fd7c7a98a6`, 13:12:15.694Z |

Both receipts report `ingested: true`, `decision: wake`, target `global-default`.
Both failed turns say:

> Native conversation receiver is unavailable; internal service fallback is refused

The KH2 inbox timestamp 13:12:32.535Z is later than its webhook receipt; the
provider's notification creation time does not establish webhook delivery time.

The configured public HTTPS hook uses the relay `/h/<opaque>/v1/hooks/linear`
path on `api.clankie.bot`. The activity Cloudflare tunnel serves another surface.
These accepted, signature-verified receipts prove the hook path worked for these
comments. No change to Linear's URL or signing secret is indicated by this evidence.
`following`, `active`, and `webhookConfigured` describe local readiness, not a
bound native receiver. `clankie trace` is not a CLI command in this install;
the TUI `/trace` concerns room trails.

The original Claude operator bridge PID 51139 started at 02:12:57Z. Its MCP TCP
connection remained established, while the native outbox was unbound. The native
Claude transcript for session `5bcd52ff-8d50-4139-962a-46b323c7a990` in `w3Z:p2N`
contains no channel message after 03:40:44.006Z. No retained bridge stderr was
found, so the error that stopped polling is **unproven**. A worker plugin 0.6.2
banner is not proof of the operator bridge's loaded code. Current main already
contains `1eb8ea93`, which keeps the outbox pump alive after a failed receipt.
The original seat, service, journals, and app settings were left unchanged.

## Fix and verification

An unavailable wake kept its external context but had no recovery when the
native receiver returned. The fix retries definite pre-delivery refusal when
that conversation establishes a native poll, using the existing coalescing
window. Taken or uncertain deliveries are not retried automatically.

A second defect rejected an ordinary global chat after a proven native
attachment saved `nativeSource`. A global chat with an attached operator remains
an allowed Linear target; rooms and side forks remain excluded.

The new [integration test](../../../apps/clankie/test/linear-native-delivery.integration.test.ts)
uses an owned localhost HTTP instance, real signed production ingress, disk
settings/journal/write receipts, the production conversation runner, native
driver fence, seat mailbox, and wire schema. It makes no live account, harness,
or model calls. It verifies:

- Bad signatures fail; offline issue and project-update comments recover as one
  wake with text and links, duplicate deliveries stay consumed, and new comments
  still wake after native attachment.
- A taken wake with a lost acknowledgment stays uncertain and is not replayed;
  its original late acknowledgment reconciles it. A fresh comment after shutdown,
  cancellation or a pre-settlement checkpoint reload excludes the original.
- Disabling following suppresses a pending wake while retaining external history.
- Assignment and delegation to the connected app, and reactions to its comments,
  match the selected rules. Assignment/reaction to someone else stays passive.
  Comment-author proof uses signed embedded identity or a retained exact write;
  a contradictory embedded author is not overridden by a write receipt.
- No internal Pi invocation occurs for the native-owned conversation.

Initial verification passed on `ash/vuh-1743-linear-wakes` at `2d23a90e`:

- Base `2acffdcf`: three new regression cases fail and one passes. The same
  four cases pass with the source patch restored.
- Six focused test files: **78 passed**. The final regression rerun: **4 passed**.
- Clankie and settings TypeScript checks; scoped `oxlint --deny-warnings`;
  local Markdown links; retired-claims check; generated public-docs check.
- Dependencies installed with `pnpm install --frozen-lockfile`. Every install,
  test, compiler, linter, and docs build used both assigned heavy wrappers.

Local raw evidence and gate output are retained in
`~/dev/clankie-wt/ash-vuh-1743-linear-wakes/.local/evidence/vuh-1743/`:
`live-trace.json`, `red-base.txt`, `focused-tests.txt`, `green-regression.txt`,
`typecheck.txt`, `lint.txt`, `doc-links.txt`, `public-docs.txt`.
The live file omits the public relay capability URL and secrets.

Follow-up verification on `ash/vuh-1743-delivery-followup`: **87 passed** across
the six focused test files (native delivery, webhook, routing, operator cancel,
operator failure and conversation driver). The eight owned native-delivery
cases include the three interrupted-take paths and nested Reaction parents.
The affected Clankie typecheck, scoped lint, formatting and docs checks pass.
Final local gate files: `followup-green.txt`, `followup-typecheck.txt`,
`followup-lint.txt` and `followup-docs.txt` in the same evidence directory.

## Activity names and remaining acceptance

`issueAssignedToYou` and `issueCommentReaction` are documented Linear notification
names ([agent best practices](https://linear.app/developers/agent-best-practices)).
This receiver consumes signed data-change envelopes and derives those names:
`Issue.assigneeId` or `Issue.delegateId` changes to the connected app actor, and
`Reaction` creates whose comment author is that actor. These fields are grounded
in Linear's [official webhook schema](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql).
Both types are now defaults; saved custom rules remain unchanged.

An admin should keep **Issue, Comment, and Reaction** resource types selected on
the existing data-change webhook ([webhook documentation](https://linear.app/developers/webhooks)).
Issue and Comment delivery were observed. Reaction subscription and actual owner
assignment/delegation/reaction delivery were not inspected or exercised live.
If Reaction is absent, add **Reaction** to that existing webhook's resource types;
retain its current URL and signing secret. No app settings were changed.

`AppUserNotification` and `AgentSessionEvent` are separate envelopes this receiver
does not consume. Enabling agent-session events creates additional lifecycle
obligations ([agent interaction](https://linear.app/developers/agent-interaction));
raw delegation wakes are not a claim of full agent-session support.

The owned mailbox test proves service delivery and acknowledgment, not actual
Claude channel consumption. After integration and an authorized original-route
recovery, the lead must correlate a fresh owner comment's webhook receipt,
external cursor, native `<channel>` message in the original transcript, and
delivery acknowledgment. A healthy MCP tool connection or protocol ACK alone is
insufficient. No live restart or repoint was authorized for this investigation.

Ticket acceptance also requests per-project routing and marking Linear inbox
notifications read. Current main explicitly uses one configured global chat and
retired account read/ack routing. Those requirements need a lead decision before
closure; this branch preserves the current architecture and does not mark inbox
notifications read.
