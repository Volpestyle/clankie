# OpenCode subagent inspection and projection

VUH-1586 inspected the installed OpenCode before implementing the projection.
The executable `~/.opencode/bin/opencode` reported **1.18.34**. The owner store
`~/.local/share/opencode/opencode.db` was inspected through SQLite
`mode=ro&immutable=1`: no owner DB, WAL or SHM was modified. This sees only the
checkpointed main database, not uncheckpointed WAL updates.

The checkpoint contained 156 sessions with `session.parent_id`, 167 completed
`task` parts and one error part. The inspected recent child sessions were
**1.17.13**, while two sessions had version 1.18.34. No 1.18.34 child or running
task was observed in this checkpoint. No provider/model turn or native worker
was started for this inspection. This is stored-shape evidence and fixture
verification, not live 1.18.34 acceptance.

Observed task parts carry `type: "tool"`, `tool: "task"`, `callID`, and
`state.status/input/time`. Completed tasks had `state.title`,
`state.metadata.parentSessionId/sessionId`, and output beginning
`<task id="ses_…" state="completed">`. Input contains `subagent_type`,
`description`, and a prompt, which the fixture omits. `state.time.start/end`
are epoch milliseconds. The error part had an input, error and time, but no
child metadata or title. Child rows had `parent_id` and a title of the form
`Description (@general subagent)`.

The existing worker/history adapter pins **1.18.18**, upstream revision
`4643e65ad6334de3e4e68dedc201d5fbb828c9fe`. Its `tool/task.ts` confirms those
parent/child metadata keys and time-bearing native task parts. It also shows
that `task_id` can continue an existing child, and background calls can return
completed tool parts with a `<task … state="running">` output. Their final
result is injected as a synthetic user text part in the parent, with a
completed/error task envelope. These pending/running/background cases are
source-derived fixture variants; they were not observed running in the store.

The service uses that existing confined history reader through registered
profiles and the same addressed-seat enrichment as Claude/Codex. Child links
are checked by exact session ID and parent, directory and version in the same
database. No child transcript, owner-wide discovery or new control authority
is added. Read and schema bounds remain enforced before parsing. Calls use
`callID` rather than child session ID, so a continuation has its own lifecycle.

The sanitized fixture is
[`opencode-subagents-native.json`](../../../apps/clankie/test/fixtures/opencode-subagents-native.json).
Focused tests exercise one-read foreground collection, background completion
and error notifications, continuations, pending/error records, unrelated
children, unaddressed/remote seats, missing registration, profile retargeting
and projection bounds. The
[existing worker checkpoint](../2026-10-04-opencode-workers/README.md) describes
the remaining native TUI/control and installed-version limitations.

## Live pinned-worker acceptance

An owned private service based on runtime `9f82ae5d`, with the fresh-pane capture
and default TUI export fixes, hired OpenCode **1.18.18** on 2026-10-04. It used
the already-configured `openai/gpt-6.1-sol` provider without credential changes.
The parent started one native general task and collected it. After opening the
seat's chat, the fleet reported `general: Lifecycle proof` with task call ID
`call_YDhIpf2dXavUjmaEQVxAtG76`, `startedAt: 2026-10-04T21:04:56.370Z`, then
`done` with `endedAt: 2026-10-04T21:06:04.419Z` in the next roster read at
`21:06:04.874Z`. The child row's `parent_id` matched the registered native
parent session; both had version 1.18.18. Times match the native task part.

Evidence is retained under
`~/.herdr-handoffs/clankie-backlog-20261003/evidence/VUH-1586/hire-fix/live-batch5-1/`
(`LIVE.json`, `INSPECTED.json`, `DISCOVERY-GUARD.json`). The shared discovery
descriptor was compared in memory before boot and after cleanup: byte-identical,
150 bytes, SHA-256 `ccd5fab11e8ff8a025954af94228a6dc9f5c8b741224df7ade07fbb01539a539`.
The private descriptor, owned pane and service process group were absent after
cleanup. Native `close_seat` returned `closed: false`; the exact owned pane was
closed through Herdr instead.

This proves the addressed-seat roster lifecycle, not a rendered app/world tray.
The hire response's persona differed from subsequent roster reconciliation,
so the probe explicitly opened a seat chat before reading subagents. Automatic
hire-to-roster persona continuity remains a separate gap. The adapter stays
pinned to 1.18.18; 1.18.34 was not exercised.
