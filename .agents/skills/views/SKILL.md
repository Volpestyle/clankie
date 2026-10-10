---
name: views
description: >-
  Use when the owner asks to see something at a glance that keeps changing, such as
  a heavy-queue or simulator board, a fleet capacity board, or a filtered issue
  list, or when a live board would answer better than a one-off status report. Builds
  a private, live view from a spec (data sources plus panels). No page source is
  written and no script runs.
---

# Views

A view is a **spec**: named data sources plus a list of panels that each show one
source. The service reads the sources live under the owner's authority. The TUI
(`/view ID`) and the app render the same spec, so you never write HTML or script.
Views are private to the owner. A view is temporary by default (24 hours, up to
7 days); a pinned view stays until someone expires it.

Make a view when someone wants to _watch_ something: "show me the heavy queue",
"keep a board of open release issues". A one-time question ("is the queue busy?")
still gets a direct answer from `clankie fleet resources` or `clankie work list`.

## Commands

All output is JSON (`docs/cli.md`, `clankie view`).

| Need                   | Command                                                    |
| ---------------------- | ---------------------------------------------------------- |
| Make one (24h)         | `clankie view create '<spec JSON>'` or `--stdin`           |
| Longer, or kept        | `... --ttl 3d` (24h–7d), or `... --pin`                    |
| What exists            | `clankie view list`                                        |
| Live data now          | `clankie view show ID` (JSON) or `show ID --text`          |
| Watch it in a terminal | `clankie view show ID --watch`                             |
| Keep / make temporary  | `clankie view pin ID`, `clankie view unpin ID [--ttl 48h]` |
| Retire it              | `clankie view expire ID`                                   |

`create` returns `{ view, render }`. Check `render.sources` before you hand the view
over: a source with `"state": "unavailable"` names the problem in `detail`, such as
a repo that isn't registered. Then tell the owner the id and how to open it:
`/view ID` in the console, which refreshes every `refreshSeconds`.

## Spec

```json
{
  "title": "Heavy queue",
  "sources": {
    "fleet": { "kind": "fleet_resources" },
    "open": {
      "kind": "tracker_issues",
      "repo": "/Users/me/dev/clankie",
      "status": ["todo", "in_progress"],
      "label": "release",
      "limit": 25
    }
  },
  "panels": [
    { "source": "fleet", "show": "capacity" },
    { "title": "Waiting", "source": "fleet", "show": "queue", "resource": "heavy" },
    { "title": "Running", "source": "fleet", "show": "leases", "resource": "heavy" },
    { "title": "Open release work", "source": "open", "show": "issues" }
  ],
  "refreshSeconds": 5
}
```

- `fleet_resources` holds what `clankie fleet resources` reads: heavy and simulator
  capacity, leases, queue and machine pressure. Its panels show `capacity`,
  `queue` or `leases`. Add `resource: "heavy"` or `"simulator"` to narrow a queue
  or lease panel.
- `tracker_issues` is a `clankie work list` filter through the repo's own tracker:
  `repo` (a registered repo id, or the repo's absolute root path; the CLI
  resolves `./`), and optionally `status`, `owner`, `label` and `limit` (1–100).
  Its panels show `issues`.
- A view has 1–8 sources and 1–12 panels. `refreshSeconds` is 2–300 (default 5).
  A panel's `title` is optional.

A heavy-queue board is `fleet` plus capacity, queue and leases panels like the ones
above. Name the view for what it watches, and leave it temporary unless the owner
says they'll keep using it.

## Boundaries

- Views are private. Nothing is shared or published. Hosted share links come
  later from the hosted service, and only after the owner confirms.
- Data appears only as each surface's own components render it. Don't put
  instructions, links you haven't checked, or secrets in titles.
- Expire views you made for a finished task. `clankie view list` shows what's
  still live.
