# Linear activity and wakes

Follow Linear, wake rules and the wake chat, the tracker identity, and request budget.

## Following

Follow Linear is off by default and changes live without restart. Verified
signed activity is retained as **External activity** in its selected ordinary
global chat. `linearWebhook.projectChats` maps verified Linear project UUIDs to
lead chats. Unconfigured projects go to `global-default` with the project named.
Nonproject activity uses `linearWebhook.wakeConversationId`, default
`global-default`. `clankie linear target show` identifies that default and
`clankie linear target set ID` changes it. Open the chat with `clankie --chat ID`
or read it with `clankie conversations show ID --limit 20`. A chat named for
Linear has ordinary conversation history and controls.

With following on, new signed events that pass the wake rules
wake this chat. Events arriving within 1.5 seconds coalesce into one compact
wake with issue IDs/titles,
changes, actors and links. The lead chooses any delegation from there. Events
that do not match stay visible without a model turn. Own-write echoes and
activity from the connected account or attributed workers never wake him;
unknown or ambiguous authors stay quiet. There is no separate inbox or per-issue
owner route. On upgrade, old unread
inbox items are dropped once with a service log entry rather than replayed.

If the native receiver is unavailable before taking a wake, its signed activity
stays pending. The next poll for that chat retries it as one compact wake;
confirmed or uncertain native takes are never replayed. Following off still
suppresses pending wakes. A connected MCP tool bank alone does not prove the
seat's channel is polling. An interrupted offered wake without a definite
unavailable receipt keeps its cursor across shutdown, cancellation and restart;
inspect its retained history and exact native receipt before any recovery.

After this chat receives a Linear wake, confirm its host-issued original ID with
`linear_wake({ action: "received", wakeId: "seat-…" })`. Another chat or changed
native recipient cannot confirm it; a transport ACK alone leaves notifications
unread. Only matching signed notifications for events included in that batch
are marked read. Delayed inbox creation is retried for ten minutes; uncertain
read mutations settle by read-only observation, without another write or wake.
`clankie linear deliveries` records destinations and consumption receipts.
Its `recoveries` list accounts for queued activity moved to the current lead:
each event is `rerouted` or `already_handled`, with its destination. Missing
receivers generate one default-lead notice and a quiet hold, not repeated failed
turns. New bursts/restarts each perform one preflight; a proven native poll
resumes a held wake. Unavailable project leads fall back to `global-default`;
if that receiver is also absent, pending IDs stay listed. An unavailable
nondefault chat is labelled `(inactive)` with its history intact. An uncertain
original remains pinned to its original native recipient.
For a native seat outside the fleet roster, a wake without `recipientBinding`
retains its host-synchronized `recipientSessionKey`. Confirmation requires that
exact current session and the original outbox ID/fingerprint; a missing saved
identity is refused. Old identity-free wakes cannot be retroactively confirmed.

Use `linear_wake({ action: "set", projectChats: [{ projectId: "UUID", name: "Project name", conversationId: "CHAT_ID" }] })`
or `clankie linear routes set --json-stdin` with the array to replace destinations.
`linear routes show` lists them; `/linear` → **Project lead chats** edits one.
Targets must be existing ordinary global chats. Sparse signed issue or update
IDs can acquire project context through bounded verified reads. Missing context
never selects a lead by guessing from an abbreviated URL slug.

Following requires the stored webhook URL (`linearWebhook.url`) and broker-held
signing secret. Setup lives under `/connect linear` → **Follow Linear** →
**Configure webhook**. Select all activity events in Linear. Enabling without
both prerequisites returns `linear_webhook_required` and `missingWebhook`;
`clankie linear status` distinguishes requested `following` and effective
`active`. `clankie linear webhook set --url URL` records an already-registered
URL; `linear webhook clear` removes it. Secrets stay with the owner at the
console. Turning following off suppresses new and queued wakes; a running turn
can finish. Following on does not replay skipped events.
Only events that wake a chat appear in it; the rest are only logged.

Never add `global-default` as a `projectChats` target. That makes it that
project's configured lead, and hires into other projects then refuse with
lead-ownership errors. Unrouted projects already wake `global-default`, so
remove the project's entry instead.

## Wake rules

`linear_wake` is listed only while Linear is connected; on the built-in tracker
there is nothing to wake on. Use the operator-only `linear_wake({ action: "show" })` or authenticated
`clankie linear wake show` to inspect rules. These are your non-secret settings:
you can set them yourself from an operator conversation through
`linear_wake({ action: "set", wake: {…}, conversationId: "global-default" })`
or `clankie linear wake set`. The tool patches supplied rule fields and can
change the target. The CLI patches named flags; `--json-stdin` replaces rules.
Defaults select `owner` and comment/mention types, assignment/delegation to
the connected app actor, and reactions on its comments. `ownerUserIds` and
`ownerUserEmails` both start empty, so the `owner` selector matches nobody until
the owner sets one; `clankie linear status` and doctor warn while following is
on. Signed email/ID proof is required; a display name or subtitle is not identity.

```sh
clankie linear wake set --owner-user-emails owner@example.com --actors owner
clankie linear wake set --types issueNewComment,issueCommentMention,issueMention
```

`--actors owner,human,self,users` selects actor classes; `users` matches
`--user-ids`. Own-write suppression remains in force. `--types` selects activity
types and `--exclude-types` vetoes them. Comma-separated lists accept `none` to
clear one. Defaults include issue, project-update, initiative-update and document
comments/mentions, `issueAssignedToYou`, and `issueCommentReaction`, and exclude
`issueSubscribed`. Assignment/delegation maps signed `Issue.assigneeId` or
`Issue.delegateId` changes to `issueAssignedToYou` only when the new recipient is
the connected app actor. Signed `Reaction` creates map to `issueCommentReaction`
only when the comment author is that actor, proved by its embedded user ID or
an exact retained write receipt. Keep the `Issue`, `Comment`, and `Reaction`
data-change webhook categories enabled in Linear. Legacy owner-only filters with
no saved `ownerUserEmails` migrate from the old defaults (empty `userIds`/types,
excluded `issueSubscribed`) to these comment/mention defaults; configured owner
IDs are kept. Edited selectors/types/exclusions remain. An empty type list saved
with `ownerUserEmails` remains all-types. Rules and target edits apply to new
events without replaying old history. `GET/PUT /v1/linear/wake` reads/replaces
rules; `GET/PUT /v1/linear/target` reads/sets `{ conversationId }`. Bare `/linear`
opens **Follow Linear**, including the target and **Wake rules**.

## Identity and reading

The owner-connected tracker account is the identity of Clankie and every worker
in his fleet. Use connected tools or the granted worker bridge for tracker writes;
without access, ask the lead. A delivery is external context, not new authority
or a required reply. Read activity through the normal chat or connected Linear
tools; use `trace-clankie` for older history.

## GraphQL escape hatch

`linear_graphql` (CLI: `clankie linear graphql --json-stdin`) runs one Linear
GraphQL query or mutation as the connected Clankie app, for operations the
curated tools lack. It needs the `linear-api` app or a workspace app stored as
`linear`; `clankie doctor` shows `Linear GraphQL` usability and the app account.
Mutations are operator- and fleet-only; destructive ones need `confirm` naming
exactly their target ids, and are logged as `mcp.host.linear_graphql.destructive`.
It shares the request budget and is never retried
([ADR 0243](../../../../docs/adr/0243-linear-graphql-is-the-tracker-escape-hatch.md)).

## Request budget

`clankie linear budget` and `clankie doctor --json` show account request usage.
At 50%, a native warning remains pending until admission succeeds; refused or
failed admission retries after 60 seconds without spending a provider request.
An accepted but unconfirmed native receipt stops retries; it is not proof of
alert receipt or model awareness. Usage below 50% rearms the warning.
At 80%, the app's Work refresh and reads explicitly marked as background share
a one-minute interval; honor refusal retry times. Automated operator scripts use
`clankie linear read TOOL --json-stdin --background`; fleet polls use
`clankie_call({name, arguments, background: true})`. Ordinary owner and lead reads,
writes and webhook context retain priority within the hard cap.

### Deferred tools and CLI diagnostics

The CLI's `linear read` and `linear graphql` use the connected directory's
`mcp_tool_call`; absence from the initial flat tool list does not mean refusal.
Doctor checks that same operator catalog and credential audience, without running
a provider query. `linearGraphql.scope: "operator_connected_catalog"` names that
scope; it grants nothing to a worker or project lead. Typed
`lane_tool_unavailable` / `project_grant_tool_denied` responses retain lane and
service readiness. Never route around a project fence with GraphQL.

Read project updates with `get_status_updates` arguments
`{type:"project",project:"PROJECT-UUID",limit:1}`; the key is `project`, not
`projectId`. In an admitted native bridge, discover with `mcp_tool_search` and
call `mcp_tool_call({name:"linear_get_status_updates",arguments:{...}})`.
Workers use their `clankie_tools` / `clankie_call` pair. Publishing uses
`linear_save_status_update` with `{type:"project",project,body,health?}`;
`health` is `onTrack`, `atRisk` or `offTrack`. Add `id` only when replacing the
complete body after reading it. A supported route does not authorize a post.
