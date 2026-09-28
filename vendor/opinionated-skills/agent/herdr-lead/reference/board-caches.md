# Board caches: datadog.json and linear.json

The board holds no credentials and never calls Datadog or Linear. Both caches
only ever change when an agent writes them, so keeping them current is the
lead's job. `R` on the board rereads whatever is on disk; `m` rereads
linear.json alone.

Both live in `~/.local/state/herdr/plugins/herd-lead/`.

## datadog.json

```json
{
  "at": "<ISO 8601 now>",
  "env": "prod",
  "series":    [{"label": "lambda errors", "window": "4h/10m", "bad": true,
                 "points": [0, 0, 3], "query": "...", "url": "..."}],
  "incidents": [{"id": "...", "title": "...", "severity": "SEV-2",
                 "since": "<ISO>", "url": "..."}],
  "monitors":  [{"id": 305911522, "name": "...", "status": "OK",
                 "scope": "service:your-api", "query": "...", "url": "..."}]
}
```

`status` is Datadog's own casing — `OK`, `Alert`, `Warn`, `No Data`. The board
derives every count from `monitors`, so send them all; it lists incidents plus
`Alert`/`Warn` under ATTENTION, dims `No Data`, and never lists `OK`. Mark a
series `"bad": true` when non-zero is the bad direction (errors, lag, DLQ depth)
— it turns red when the last point is above zero. `points` is oldest → newest;
the sparkline scales to its own peak, so send raw counts.

The view's LINKS section works with no cache at all — set it with `C` → datadog
quick links, `HERD_LEAD_DD_DASHBOARDS="label=url label=url"` (URL-encode spaces,
the list splits on whitespace), or a `"dashboards"` array in the cache.

### Filling it

Site-specific queries live next to the cache in `refresh.md`. Read that first;
if it is missing, derive the shape from your team's Datadog skill:

- `search_datadog_monitors` — one query wide enough to catch every monitor your
  team owns, plus extra searches for upstream monitors that feed your pipeline
  but are tagged to another team.
- `search_datadog_incidents` — `state:(active OR stable)` scoped to your
  services and team.
- `get_datadog_metric` — a small standard series set, all `"bad": true`, with
  `from: "now-4h"`, `raw_data: true`. Flows lead and levels lag, so queue age
  and DLQ depth ride alongside error counts.

**A metric with no series means zero, not missing** — write an array of zeros
rather than dropping the row, or the board cannot tell "quiet" from "never
fetched".

### `No Data` is a resting state, not a fault

Two causes worth telling apart; put the answer in an optional per-monitor
`"note"`, which the detail panel shows as `why`:

- **The event never happened.** `aws.lambda.enhanced.timeouts`, `.out_of_memory`
  and `aws.lambda.throttles` are only emitted when the bad thing occurs, so a
  healthy function publishes no points at all. This is the majority, and it is
  good news.
- **The function was never invoked.** Duration / p95 monitors have nothing to
  average when their Lambda sat idle — true of the retry webhook (it only fires
  when the main one fails) and of unused integrations.

Before calling either a fault, check the metric at env scope rather than
function scope: if `sum:aws.lambda.enhanced.timeouts{env:<your env>}` returns
points while one function shows none, the integration is fine and the absence is
real.

Every count is as fresh as the last write, so read the age before reporting prod
healthy — a clear board that is four hours old says nothing about now.

## linear.json

The board's `N active tickets` count is derived entirely from worktrees, so the
one thing it cannot see is a ticket assigned to the user with no worktree yet.
That is what this file is for.

```json
{
  "at": "<ISO 8601 now>",
  "issues": [{"id": "TEAM-1127", "title": "...", "state": "In Progress",
              "url": "https://linear.app/<workspace>/issue/TEAM-1127"}]
}
```

Fill it with `list_issues` for the user's own started work — assignee `me`, an
active state — and write **every** issue you get back. The board joins on `id`:
an issue matching a worktree branch is ignored (the worktree says more about
it), and one that doesn't shows as `+K no branch`. So the file is a *superset* —
don't pre-filter it to "things without branches", or the join has nothing to
work with.

Say the age when you report from it.
