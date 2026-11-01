# Connected leads

For an app that leads through Clankie's connector (Claude Duet, Grok, Claude
Code, Codex and others), beside [lead](../SKILL.md). Every connected lead follows
it; none takes precedence over another.

- **Hire on the owner's machines for building and checking.** Code changes,
  builds, test runs and anything that needs a real checkout, the owner's tools or
  their machines go to a Clankie worker with `start_agent`. Do the work yourself
  when that fits better: planning, research, reading, writing that needs no
  checkout.
- **Herdr desktop app seats only.** Local workers run in the Herdr desktop
  app's terminals (herdr-core seats), never in Herdr TUI panes. `start_agent`
  hires there where the app's core runs
  ([ADR 0319](../../../../docs/adr/0319-hires-run-in-the-desktop-apps-terminals.md)).
  If a desktop hire doesn't come up or can't be messaged, tell the owner rather
  than hiring into a TUI pane.
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
