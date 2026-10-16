# Views in the console, and two view boundaries (VUH-2035)

Tracks: [VUH-2035](https://linear.app/vuhlp/issue/VUH-2035). Based on `origin/main`
at `14fd18fee`. Earlier proof: [2026-10-10 views](../2026-10-10-views/README.md).

## Outcome

The first slice landed on 2026-10-10. This change closes its remaining gaps:

1. **Device repo boundary.** Since VUH-2042, a paired device with terminal
   control reaches `POST /v1/operator/views`. Tracker sources are read as a local
   caller, so a device-created view whose `repo` was an absolute path would
   register that directory and read its tracker. ADR 0191 lets a device name
   only a registered repo id. The views route now knows whether its caller is
   the operator bearer or a device, counting a device paired through the hosted
   account whose request arrives inside `/v1/hosted/operator`. A device's
   create with a path is refused with 400, and the view is not kept, so no
   render can enroll the path.
2. **Terminal-safe rendering.** `formatViewLines` feeds `view show --text`,
   `--watch` and the console's `/view` panel. It printed issue titles, owners,
   repo names, process names and error details raw, so an escape sequence in a
   tracker title reached the owner's terminal: OSC 52 writes the clipboard, and
   CSI clears the screen. Every data-derived string now has its control
   characters replaced by spaces before styling. The JSON render still carries
   the text as the source holds it.
3. **`/view` in a real console.** This was the one acceptance item without
   evidence. The capture is below.

## `/view` follows a moving heavy queue

**How it ran.**

- **Service:** a scratch stack (`node scripts/scratch-stack.mjs .local/views-tui
--broker-operator`) ran this worktree's service through
  `clankie heavy --server`, with its own private fleet registry. The owner's
  service and the live registry were never touched.
- **Capacity:** the scratch fleet was set to one heavy slot (`fleet set
--heavy-slots 1`), and `view create` made `view_08d204cb130c`: one
  `fleet_resources` source, with Capacity, Waiting (heavy) and Running (heavy)
  panels, refreshing every 2 s.
- **Console:** the real launcher console (`scratch-stack.mjs run … cli`) ran in
  an owned Herdr tab at 110 columns, with `/view view_08d204cb130c` typed into it.
- **Queue:** `raw/drive.sh` started three real heavy holders (`heavy-driver.mjs`
  → `governor.runHeavy`) against that registry, three seconds apart. It
  released one every 30 seconds.
- **Capture:** `herdr pane read` captured the pane every 5 seconds: 24 text and
  ANSI reads, retained locally. The five frames below are committed in
  `captures/`, and the driver's timeline is `raw/drive.log`.

The panel stayed open the whole time; nothing was retyped or reopened.

| Read    | Panel (`captures/`)                                                      |
| ------- | ------------------------------------------------------------------------ |
| 2:54:05 | `1-empty`: 0/1 in use, nothing waiting, no leases                        |
| 2:54:19 | `2-alpha-running-two-waiting`: alpha running 12 s; beta 1st, gamma 2nd   |
| 2:54:51 | `3-beta-running`: alpha released at 2:54:45, beta running, gamma waiting |
| 2:55:19 | `4-gamma-running`: beta released at 2:55:15, gamma running, queue empty  |
| 2:55:49 | `5-drained`: gamma released at 2:55:45, 0/1 in use, no leases            |

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Heavy queue  view_08d204cb130c · expires in 23h58m · read 2:54:19 AM     │
│                                                                          │
│ Capacity                                                                 │
│ heavy       █  1/1 in use                                                │
│ simulators  ░  0/1 in use                                                │
│ queue       2 waiting                                                    │
│ pressure    ok  load 0.50 · 36.2 GB free                                 │
│                                                                          │
│ Waiting                                                                  │
│  1. heavy     node  seat board-beta  waiting 10s                         │
│  2. heavy     node  seat board-gamma  waiting 7s                         │
│                                                                          │
│ Running                                                                  │
│ heavy     node  seat board-alpha  running  12s                           │
│                                                                          │
│ live · every 2s · esc close                                              │
└──────────────────────────────────────────────────────────────────────────┘
```

(The frame is narrowed here; `captures/2-alpha-running-two-waiting.txt` is the read
at full width.)

## Clankie builds the board from a one-line ask (deployed runtime)

On the deployed runtime (`8eda89c14`, which includes `7d7a4063d`), the ask went to
the owner conversation at 03:25:42:

```
clankie send --conversation global-default --delivery queue \
  "Make me a live board of the heavy queue so I can watch it move."
```

The receipt was `accepted`, with delivery stage `delivered` and seat delivery
`started` (run `run-049c09e2-be7a-4765-a516-175892b5421c`). VUH-2045 had blocked
this route on 2026-10-10; it now works. The ask arrived as a worker's message,
not as a turn the owner typed.

At 03:25:58, 16 s later, Clankie had created `view_d58ff18d1f79`. It has one
`fleet_resources` source with Capacity, Waiting (heavy) and Running (heavy)
panels, is temporary for 24 h, and refreshes every 5 s.

The installed `clankie view show view_d58ff18d1f79 --text` read the board for
four minutes. The machine's heavy queue stayed idle throughout (`live/1-idle`).

To make it move, five `clankie heavy --seat views-proof-N -- sleep 20` jobs went
through the live governor, one second apart. That briefly held all four
full-lane slots of the real fleet.

| Read    | Board (`live/`)                                                        |
| ------- | ---------------------------------------------------------------------- |
| 3:26:09 | `1-idle`: 0/4 in use, nothing waiting                                  |
| 3:30:37 | `2-full-one-waiting`: 4/4 in use, `views-proof-1`–`4` running, 5 waits |
| 3:30:54 | `3-last-running`: 1–4 finished, `views-proof-5` running, queue empty   |
| 3:31:16 | `4-drained`: 0/4 in use, no leases                                     |

The spec never changed between reads.

## Tests

| Guarantee                                 | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fails when sabotaged                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| A device names a tracker only by its id   | `apps/relay/test/fleet-settings-roundtrip.integration.test.ts`. A real device session goes through the real relay and service, backed by the real work-items service. An unregistered path and a registered path are both refused (400 through the relay; the exact reason from the service). A hosted-paired device inside `/v1/hosted/operator` is refused the same way, with no view kept. The registered id renders the owner's issue. The local operator bearer may still name a path (201). | device check disabled, or the hosted guard removed (201 instead of 400) → **fails** |
| No control character reaches the terminal | `apps/clankie/test/views.integration.test.ts`. A real tracker item whose title carries OSC 52, CSI 2J and a C1 CSI goes through the real CLI, HTTP and store. The JSON render keeps the title; `show --text` prints it with spaces and no control character but newlines.                                                                                                                                                                                                                         | sanitizer removed → **fails**                                                       |

The existing views and relay suites still pass (10/10 across both files).

## Independent review

A native review (escalation and bypass) found that the first fix missed the hosted
route. A device paired through the hosted account sends its create inside
`/v1/hosted/operator`. There the service authenticates the inner request as the
operator, so the path check was skipped. The view's caller now counts that
request as a device, matching the existing `hostedOriginalRequests` guard on
model-key entry, and the test above covers it. On the reviewer's advice,
`lease.state` and the `/view` panel's error notice now go through the same
sanitizer. Checked and holding:

- trimmed and Unicode-prefixed repo refs;
- relative paths, `~`, and Windows paths on POSIX;
- `project-…` refs;
- pin, unpin and expire, which cannot change a spec;
- the self-hosted relay, which forwards the device's own bearer;
- support devices, which have no terminal control;
- `\p{Cc}` covering C0, DEL and C1.

## Not covered here

- **App rendering** is VUH-2042 (clankie-app): the renderer landed; the
  on-device proof is still open.
- **Hosted share links** are clankie-ops work, and snapshots come later.
- **The relay's refusal** says `settings_upstream_refused` rather than the
  service's reason. The relay does this for every proxied owner route, and the
  app never creates views.
- **Views created by a device before this change** with a path are still read
  as a local caller; a pinned one never expires. The app has never sent a create,
  so such a view would need a hand-built client holding terminal control. The
  reviewer's sturdier alternative closes this too: store an operator's path as
  its registered id at create, and render as a device. It also changes how
  existing stored views read, so it is left for a follow-up (below).
- **Pre-fix path views:** storing a tracker source by its registered id at create
  is [VUH-2323](https://linear.app/vuhlp/issue/VUH-2323).
