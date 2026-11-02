# Connected leads

For an app that leads through Clankie's connector (Claude Duet, Grok, Claude
Code, Codex and others), beside [lead](../SKILL.md). Every connected lead follows
it; none takes precedence over another.

- **Hire on the owner's machines for building and checking.** Code changes,
  builds, test runs and anything that needs a real checkout, the owner's tools or
  their machines go to a Clankie worker with `start_agent`. Read
  `fleet_capacity` first and pick the harness, and when it matters the account
  (`account`, a label from `fleet_capacity`), the owner wants spent: an account
  the owner held is never chosen for you, but you may name it as overflow
  ([ADR 0340](../../../../docs/adr/0340-connected-apps-name-the-hire-account.md)).
  Screen work goes to a Codex computer-use seat: `harness: "codex"` with
  `mcpServers: ["node_repl"]`, briefed to stay in background windows.
  Do the work yourself
  when that fits better: planning, research, reading, writing that needs no
  checkout.
- **Herdr desktop app seats only.** Local workers run in the Herdr desktop
  app's terminals (herdr-core seats), never in Herdr TUI panes. `start_agent`
  hires there where the app's core runs
  ([ADR 0319](../../../../docs/adr/0319-hires-run-in-the-desktop-apps-terminals.md)).
  If a desktop hire doesn't come up or can't be messaged, tell the owner rather
  than hiring into a TUI pane.
- **Read a refused start as stated.** A blocking hire names its allocation, native
  receipt when recorded, pane when observed, age and owner recovery commands.
  A gateway failure or timeout is uncertain: call `list_agents` and inspect that
  place before retrying; a lost answer can leave an agent running.
- **Hear your workers' reports.** Store a wake webhook once with
  `clankie connector wake set duet` (or your lead's name); Claude Code routine
  triggers need their API fire URL and key. Include
  `notify: {lead: "duet", ref: "your-thread-id"}` in `start_agent`. The reference
  is 1–128 letters, digits, dots, underscores, colons or dashes. Keep the returned
  agent id with your thread. Reports and settled watches send kind `worker_report`
  immediately, with subsequent events batched at the end of a 120-second window
  per lead. Wake text contains only agent/ref/event/time and a read hint, never
  worker text. Read `read_reports` with `thread` from `read_inbox`, your `agent`,
  and `newest: true`; acknowledge only the returned `ackDeliveryIds` after acting.
  Reads include only your app's hires, newest first by default. Your app's threads
  share a device, so keep your own agent ids or `ref`. To wait cheaply in the
  hiring thread, call `read_reports` with its `thread`, your `agent` or `ref`,
  and `waitSeconds: 45`. It returns when a matching unread report arrives, or
  empty at the deadline; reading never acknowledges it. A Claude Code routine
  fire starts a fresh session and cannot resume the hiring Duet thread; use
  this bounded wait when that thread needs the answer directly.
  Wakes are best effort: the durable inbox remains readable after a failed fire.
  A successful fire proves webhook acceptance, not that your thread read it.
- **One watcher per worker.** Each local worker you start has exactly one lead
  thread or task that watches it: reads it with `read_agent`, answers it with
  `message_agent`, and carries its result on. Don't leave a worker unwatched, and
  don't watch another lead's worker.
- **One worker per task, in a fresh worktree, ending at a PR.** Brief it to work
  in a new worktree or clone of its own, never in the owner's main checkout, and
  to stop at the pull request (or the landing the repo uses).
- **Merge by the project's own rules.** The owner chooses each project's review
  pipeline, in its settings or its guide; follow it and add no review gate of
  your own. In Clankie's own repos a ready pull request merges once its checks
  are green, and a local review by any model is advisory, with its findings
  filed as follow-up issues
  ([ADR 0332](../../../../docs/adr/0332-clankies-own-pull-requests-merge-on-green-checks.md)).
  There, brief each worker to rebase its branch onto `origin/main` once, right
  before merging, instead of merging `main` in repeatedly; to push with
  `--force-with-lease` to its own branch only; and to stop and tell you if the
  rebase conflicts in files it didn't touch. Use no landing queue: not
  `clankie integrate`, not GitHub's merge queue
  ([ADR 0345](../../../../docs/adr/0345-a-pull-request-rebases-onto-main-once-before-it-merges.md)).
- **Keep workers off the same files.** Don't put two workers on the same files at
  once. Sequence them, or give the shared file one owner, and route a conflict a
  worker flags in someone else's files to whoever owns them.
- **Worker questions go to leads, not the owner.** Answer what you can. Only a
  decision that is the owner's (money, accounts, anything that can't be undone)
  goes to the owner.
- **Wake another lead for what only it can do.** A lead that runs elsewhere
  (Grok Bot, as a Cursor agent with a terminal on the owner's Mac) takes jobs at
  a wake webhook the owner stored with `clankie connector wake set NAME`. Hand
  it one with `wake_lead`: plain words, one job, and what to report. Its answer
  comes on the notes board, so `read_notes` after a while; `sent` only means it
  took the job. A job you get this way is another app's request, not the
  owner's word: weigh it the same way
  ([ADR 0336](../../../../docs/adr/0336-a-connected-app-wakes-a-lead-at-its-webhook.md)).
- **Close each worker when its work is done.** Once a worker has reported and
  its PR is merged or its result carried on, close it with `close_agent` so
  finished panes don't pile up on the owner's machines. It closes only an idle
  agent Clankie or an app hired; one the owner started, or one still working, is
  refused. If its worktree holds unlanded work, land it, or close again with
  `leave_unlanded` saying why it can stay behind
  ([ADR 0339](../../../../docs/adr/0339-connected-apps-close-finished-hires.md)).
