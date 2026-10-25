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
session with a first historical fold, then prove its fresh tool event.
This is a local dependency integration proof, not a live owner conversation.

Focused command (governed):

```sh
clankie heavy -- node_modules/.bin/vitest run \
  apps/clankie/test/current-activity-http.integration.test.ts \
  apps/relay/test/operator-conversations.test.ts \
  apps/tui/test/status-connection.test.ts \
  apps/clankie/test/presence-events.integration.test.ts
```

Result: **4 files / 170 cases pass**. The relay's HTTP checks verify private
activity uses the exact owner-device route and refuses read-only/support
identities before dispatch. A real upstream HTTP adapter check carries the
private presence opt-in and original device bearer to the service. The CLI checks verify the operator bearer, opt-in
request and decoded activity. Existing presence event checks stay green.

The required exact-head root landing gate and Sage review are pending at this
commit. This evidence makes no native-layout or live-desktop claim.
