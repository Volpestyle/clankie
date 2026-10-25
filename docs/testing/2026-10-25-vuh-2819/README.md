# VUH-2819 — owner activity contract

Core slice for [VUH-2819](https://linear.app/vuhlp/issue/VUH-2819). The private
app's pet layout and visual evidence are a separate candidate.

The new `current-activity-http.integration.test.ts` starts real HTTP routes,
conversation journal, presence projection and voice lease store. Actual native
and call events traverse those components and the strict wire schema. It checks
coding, issue, Discord and chat/call sources; stable IDs/cursors; structured and
free-text credential redaction; exact issue-key navigation; completed tools;
idle-to-working without replay; voice lease release; withheld mixed rooms and
first transcript folds; owner-only admission and revalidation after a wait.
Regression controls release/reacquire voice for the same conversation without
a read in between, then prove fresh-call text; and replace a working native
session with a first historical fold, then prove its fresh tool event. A fresh
census replacement also invalidates the prior occupant before any new transcript;
unchanged-head and fresh-replacement controls retain the correct event.
This is a local dependency integration proof, not a live owner conversation.

Focused command (governed):

```sh
clankie heavy -- node_modules/.bin/vitest run \
  apps/clankie/test/current-activity-http.integration.test.ts \
  apps/relay/test/operator-conversations.test.ts \
  apps/tui/test/status-connection.test.ts \
  apps/clankie/test/presence-events.integration.test.ts \
  apps/clankie/test/conversation-questions.test.ts
```

Result after the pending-question follow-up: **5 files / 211 cases pass**. The relay's HTTP checks verify private
activity uses the exact owner-device route and refuses read-only/support
identities before dispatch. A real upstream HTTP adapter check carries the
private presence opt-in and original device bearer to the service. The CLI checks verify the operator bearer, opt-in
request and decoded activity. Existing presence event checks stay green.

The original activity contract landed at `6586fd354396231a5aecdbee83ad1156861d0e98`.
Its exact-head root gate passed **6,981 tests / 790 files**, with 89 cases
skipped, all 23 typecheck tasks green and final revalidation exit 0. Sage approved
exact patch `8cd57284`. The successful full retry needed no failed-file recovery.
The preceding loaded hook deadline failure passed three isolated runs; the
profiled third initial hook took 827 ms internally against its two-second budget.
The same file also passed in the successful full gate. No assertion was changed.

The separate pending-question follow-up uses the canonical oldest pending owner
question already selected for presence. It redacts the full prompt, identifies
the question/incarnation stably and targets the question's own thread. Real
store and HTTP controls prove full text beyond the old 200-character title,
stable reads, owner-only opt-in, unchanged legacy title, answer/cancel clearing,
a fresh replacement ID and withheld mixed-room questions. Underlying event
lifetimes keep being pruned while the question is visible: an idle-to-working
transition cannot resurrect the old tool after an answer. That regression
failed before the lifetime-order repair and passes afterward.

This follow-up's exact-head root gate and fresh Sage review are pending at this
commit. There is no native-layout or live-desktop claim here; the separate app
capture evidence is explicitly labelled fixture data.
