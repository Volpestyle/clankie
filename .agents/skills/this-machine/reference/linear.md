# Linear activity and wakes

Follow Linear, wake rules and the wake chat, the tracker identity, and request budget.

## Following

Follow Linear is off by default and changes live without restart. Verified
signed activity is retained as **External activity** in one ordinary global
chat, selected by `linearWebhook.wakeConversationId`; the default is
`global-default`. `clankie linear target show` identifies it and
`clankie linear target set ID` changes it. Open the chat with `clankie --chat ID`
or read it with `clankie conversations show ID --limit 20`. A chat named for
Linear has ordinary conversation history and controls.

With following on, new signed events that pass the wake rules
wake this chat. Events arriving within 1.5 seconds coalesce into one compact
wake with issue IDs/titles,
changes, actors and links. The lead chooses any delegation from there. Events
that do not match stay visible without a model turn. Own-write echoes and
activity from the connected account or attributed workers never wake him;
unknown or ambiguous authors stay quiet. There is no notification poll,
separate inbox, read/ack protocol, or per-issue route. On upgrade, old unread
inbox items are dropped once with a service log entry rather than replayed.

If the native receiver is unavailable before taking a wake, its signed activity
stays pending. The next poll for that chat retries it as one compact wake;
confirmed or uncertain native takes are never replayed. Following off still
suppresses pending wakes. A connected MCP tool bank alone does not prove the
seat's channel is polling. An interrupted offered wake without a definite
unavailable receipt keeps its cursor across shutdown, cancellation and restart;
inspect its retained history and exact native receipt before any recovery.

Following requires the stored webhook URL (`linearWebhook.url`) and broker-held
signing secret. Setup lives under `/connect linear` → **Follow Linear** →
**Configure webhook**. Select all activity events in Linear. Enabling without
both prerequisites returns `linear_webhook_required` and `missingWebhook`;
`clankie linear status` distinguishes requested `following` and effective
`active`. `clankie linear webhook set --url URL` records an already-registered
URL; `linear webhook clear` removes it. Secrets stay with the owner at the
console. Turning following off suppresses new and queued wakes; a running turn
can finish. Following on does not replay passive history.

## Wake rules

Use the operator-only `linear_wake({ action: "show" })` or authenticated
`clankie linear wake show` to inspect rules. These are your non-secret settings:
you can set them yourself from an operator conversation through
`linear_wake({ action: "set", wake: {…}, conversationId: "global-default" })`
or `clankie linear wake set`. The tool patches supplied rule fields and can
change the target. The CLI patches named flags; `--json-stdin` replaces rules.
Defaults select `owner` and comment/mention types, assignment/delegation to the connected app actor, and reactions on its comments. `ownerUserIds` and
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
