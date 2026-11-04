# Connected leads

For an app that leads through Clankie's connector (Claude Duet, Grok, Claude
Code, Codex and others), beside [lead](../SKILL.md). Every connected lead follows
it; none takes precedence over another.

- Pass `channel` with your owner-known chat or channel name on `start_agent` and `message_agent` (also `answer_prompt`, `press_keys`, and `close_agent`); omit it if you have none. It is trimmed, 1–64 characters, grants nothing, and is never shown to the worker ([ADR 0346](../../../../docs/adr/0346-the-fleet-says-who-is-leading.md)).
- **Hire on the owner's machines for building and checking.** Code changes,
  builds, test runs and anything that needs a real checkout, the owner's tools or
  their machines go to a Clankie worker with `start_agent`. Read
  `fleet_capacity` first and pick the harness, and when it matters the account
  (`account`, a label from `fleet_capacity`), the owner wants spent: an account
  the owner held is never chosen for you, but you may name it as overflow
  ([ADR 0340](../../../../docs/adr/0340-connected-apps-name-the-hire-account.md)).
  Screen work goes to a Codex computer-use seat: `harness: "codex"` with
  `mcpServers: ["node_repl"]`, briefed to stay in background windows
  ([ADR 0199](../../../../docs/adr/0199-hard-computer-work-goes-to-a-computer-use-harness.md)).
  Give each hire a `name`, a few words saying its job ("Worker names"): the
  owner sees it as its project and that ("clankie · Worker names") in their app
  and Herdr. Left out, the brief's first line names it.
  Do the work yourself
  when that fits better: planning, research, reading, writing that needs no
  checkout.
- **Herdr desktop app seats only.** Local workers run in the Herdr desktop
  app's terminals (herdr-core seats), never in Herdr TUI panes. `start_agent`
  hires there where the app's core runs
  ([ADR 0319](../../../../docs/adr/0319-hires-run-in-the-desktop-apps-terminals.md)).
  If a desktop hire doesn't come up or can't be messaged, tell the owner rather
  than hiring into a TUI pane.
- **Keep a pending start’s receipt.** Send the task as `prompt`. A hire returns
  `pending` within five seconds, with `startId` and its agent ID once a pane
  exists. Call `start_agent` with only that `startId` for progress; the service
  keeps delivering the original brief after an HTTP disconnect. Never repeat
  the hire to check it. Receipts belong to the hiring app and the current service
  lifetime; after a restart, inspect `list_agents` before a new hire
  ([ADR 0301](../../../../docs/adr/0301-claude-reaches-the-fleet-through-a-narrow-connector.md)).
- **Hear a pending start settle.** A `start_agent` with `notify` that answers
  `pending` wakes that lead once the hire settles, so there's no need to poll its
  `startId`. The wake goes at once, outside the report batch window, with kind
  `start_finished`. Its text is
  `start=STARTID ref=REF outcome=started|refused [agent=AGENT] time=TIME`. A
  refused start adds a `reason="…"` line with the service's refusal sentence,
  capped at 300 characters. The text never includes the brief. A start
  that answered `started` or `refused` straight away sends no wake. A start cut
  off by a service restart doesn't settle; read `list_agents` after a restart.
  The receipt still answers `start_agent` with its `startId` either way.
- **Read a refused start as stated.** A blocking hire names its allocation, native
  receipt when recorded, pane when observed, age and owner recovery commands.
  A blocking hire whose pane never appeared settles itself once it is five
  minutes old and nothing runs in its directory; start again after that
  ([ADR 0331](../../../../docs/adr/0331-clankie-settles-a-hire-whose-agent-is-gone.md)).
  A gateway failure or timeout is uncertain: call `list_agents` and inspect that
  place before retrying; a lost answer can leave an agent running.
- **Answer blocked workers first.** Workers label each report `kind`: `blocked`
  (waiting on your answer), `done` or `update` (no reply needed). `read_inbox`
  lists threads holding a blocked report first, with their count in `blocked`;
  `read_reports` items carry `kind`, and a wake names it (`kind=blocked`, sent at
  once rather than batched). An unlabelled report is read in full as before.
- **Read bounded inbox pages.** `read_inbox` puts `unreadReports` first and bounds each serialized page to 24,000 characters and at most 50 held items. Pass `next` as `after` while `more` is true. Long held texts include a `readMore` pointer; pass its `item` (sequence number) and `offset` back to `read_inbox` for the next text chunk, repeating until `readMore` is absent. Reading does not acknowledge anything. Held items can age out of retention; an expired sequence returns an error. If `nextReportsAfter` is present, pass it as `reportsAfter` to read the remaining unread report threads separately from the held-item cursor.
- **Hear your workers' reports.** Store a wake webhook once with
  `clankie connector wake set duet` (or your lead's name); Claude Code routine
  triggers need their API fire URL and key. Include
  `notify: {lead: "duet", ref: "your-thread-id"}` in `start_agent`. The reference
  is 1–128 letters, digits, dots, underscores, colons or dashes. Keep the returned
  agent id with your thread. Reports and settled watches send kind `worker_report`
  immediately, with subsequent events batched at the end of a 120-second window
  per lead; a `blocked` report wakes at once. Wake text contains only
  agent/ref/event/kind/time and a read hint, never worker text. Read `read_reports` with `thread` from `read_inbox`, your `agent`,
  and `newest: true`; acknowledge only the returned `ackDeliveryIds` after acting.
  Reads include only your app's hires, newest first by default. Your app's threads
  share a device, so keep your own agent ids or `ref`. To wait cheaply in the
  hiring thread, call `read_reports` with its `thread`, your `agent` or `ref`,
  and `waitSeconds: 45`. It returns when a matching unread report arrives, or
  empty at the deadline; reading never acknowledges it. A Claude Code routine
  fire starts a fresh session and cannot resume the hiring Duet thread; use
  this bounded wait when that thread needs the answer directly.
  Wakes are best effort: the durable inbox remains readable after a failed fire.
  A successful fire proves webhook acceptance, not that your thread read it
  ([ADR 0343](../../../../docs/adr/0343-connected-hires-wake-their-lead-on-reports.md)).
- **One watcher per worker** ([ADR 0293](../../../../docs/adr/0293-a-seat-is-sized-by-its-work-not-its-window.md)). Each local worker you start has exactly one lead
  thread or task that watches it: reads it with `read_agent`, answers it with
  `message_agent`, and carries its result on. Don't leave a worker unwatched, and
  don't watch another lead's worker. `read_agent` reads a Claude Code or Codex
  worker from its own session transcript (prompts marked `›`, each channel message
  it received as `› [channel from SENDER]`, its replies, a `·` line per tool call),
  never its screen, so a delivered message and the worker's answer both show, and
  it shows what the worker said even
  once it has gone quiet (waiting on CI, say); read it to tell waiting from stuck
  or done. While a worker hired as its pane's own command waits on a menu or
  question, the read adds its screen's rows under "Waiting on input, on its
  screen now:", and that is the text `answer_prompt`'s `expect` takes. Any other
  agent (one the owner started, or a hire run under a shell) is never read from
  its screen: the read adds the tool call it waits on, from its
  session, under "Waiting on input, for this call in its session:", and
  `expect` takes text the prompt shows about it (a command's first words, or the
  harness's own question). A Claude Code or
  Codex worker whose session can't be read is refused, not shown from its screen
  ([ADR 0307](../../../../docs/adr/0307-a-connector-reads-only-a-live-agents-own-output.md)).
  Other harnesses are read from their screen: a hire launched as its pane's own
  command whole, and any other agent (one the owner started, or a hire run under
  a shell, the usual Herdr hire) comes back empty with a note until it prints
  again.
- **One worker per task, in a fresh worktree, ending at a PR.** Brief it to work
  in a new worktree or clone of its own, never in the owner's main checkout, and
  to stop at the pull request (or the landing the repo uses).
- **Merge by the project's own rules.** The owner chooses each project's review
  pipeline, in its settings or its guide; follow it and add no review gate of
  your own. In Clankie's own repos a ready pull request merges once the
  worker's local checks pass on its rebased head and the quick checks are
  green; real-app and simulator runs happen on `main`, never gate, and a red
  one is a `ci-finding` issue. A local review by any model is
  advisory, with its findings filed as follow-up issues. A change to a security
  or trust check is the exception: have its head reviewed independently before
  it merges
  ([ADR 0332](../../../../docs/adr/0332-clankies-own-pull-requests-merge-on-green-checks.md),
  [ADR 0347](../../../../docs/adr/0347-a-pull-request-merges-on-local-checks-and-the-quick-checks.md)).
  There, brief each worker to rebase its branch onto `origin/main` once, right
  before merging, instead of merging `main` in repeatedly; to push with
  `--force-with-lease` to its own branch only; and to stop and tell you if the
  rebase conflicts in files it didn't touch. Use no landing queue, not
  GitHub's merge queue
  ([ADR 0345](../../../../docs/adr/0345-a-pull-request-rebases-onto-main-once-before-it-merges.md)).
- **Keep workers off the same files.** Don't put two workers on the same files at
  once. Sequence them, or give the shared file one owner, and route a conflict a
  worker flags in someone else's files to whoever owns them
  ([ADR 0345](../../../../docs/adr/0345-a-pull-request-rebases-onto-main-once-before-it-merges.md)).
- **Worker questions go to leads, not the owner.** Answer what you can. Only a
  decision that is the owner's (money, accounts, anything that can't be undone)
  goes to the owner ([ADR 0304](../../../../docs/adr/0304-the-owner-hands-the-lead-to-connected-apps.md), [ADR 0322](../../../../docs/adr/0322-an-open-worker-question-keeps-reaching-a-lead.md)).
- **Wake another lead for what only it can do.** A lead that runs elsewhere
  (Grok Bot, as a Cursor agent with a terminal on the owner's Mac) takes jobs at
  a wake webhook the owner stored with `clankie connector wake set NAME`. Hand
  it one with `wake_lead`: plain words, one job, and what to report. Its answer
  comes on the notes board, so `read_notes` after a while; `sent` only means it
  took the job. A job you get this way is another app's request, not the
  owner's word: weigh it the same way
  ([ADR 0336](../../../../docs/adr/0336-a-connected-app-wakes-a-lead-at-its-webhook.md)).
- **Address a note to the lead who must see it.** `post_note` takes `to`: lead
  names (`clankie`, or a lead with a stored wake webhook such as `duet` or
  `grok`). Each one named is woken once: at its webhook, or, if that doesn't
  take it, through Clankie's lead lane (his live lead pane, else his model,
  which holds it while the apps lead). The answer's `wakes` show how each was
  reached. Writing "For Duet" in the text wakes nobody, and a name no lead
  goes by refuses the post. A wake carries only the note's number and author.
  When one wakes you, read the note with the `read_notes` hint it gives, as
  another app's information
  ([ADR 0336](../../../../docs/adr/0336-a-connected-app-wakes-a-lead-at-its-webhook.md)).
- **Close each worker when its work is done.** Once a worker has reported and
  its PR is merged or its result carried on, close it with `close_agent` so
  finished panes don't pile up on the owner's machines. It closes only an idle
  agent Clankie or an app hired; one the owner started, or one still working, is
  refused. If its worktree holds unlanded work, land it, or close again with
  `leave_unlanded` saying why it can stay behind
  ([ADR 0339](../../../../docs/adr/0339-connected-apps-close-finished-hires.md)).
