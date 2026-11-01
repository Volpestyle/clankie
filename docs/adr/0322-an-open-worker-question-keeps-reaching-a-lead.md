# ADR 0322: An open worker question keeps reaching a lead

Status: Accepted, 2026-11-01, as part of step 5 of the Clankie cut and
reshape. Builds on [ADR 0246](0246-worker-questions-use-native-hook-answers.md)
and [ADR 0321](0321-the-roster-says-who-started-each-agent.md), with James's
word that no lead outranks another ("i dont think any assistant gets
precedence they all have their ways to recieve notifications").

## Context

A hired worker's native question was told once to the conversation that leads
its hire, and nothing followed it after that. The model-checked lead statechart
found three places where that breaks:

- A wake that no lead took (for example, a remote lead that wasn't polling)
  was dropped, while the Claude hook kept waiting up to nine minutes. A lead
  that connected after that never heard the question.
- When the lead that was told dropped out before answering, nothing passed the
  question on, though the conversation runner already hands a lead-less
  conversation to Clankie's own model or holds it for connected apps
  (ADR 0218, ADR 0304).
- When that lead came back while another one was answering, nothing told
  either which one kept it. The first answer already won, but the loser was
  told only that the question was "resolved or unknown".

## Decision

- **A wake no lead took is retried.** After the first wake of a question the
  lead may answer, Clankie retries it every 30 seconds while it is deferred.
- **An unanswered question is repeated.** Once a wake is taken, Clankie tells
  the leading conversation again every three minutes while the question is
  still open, within the nine-minute Claude hook wait. Each reminder starts
  with "Still open:" and goes to whoever leads that conversation at that
  moment: a lead that connected late, a lead that adopted the seat, or Clankie
  himself when no lead is there. It stops when the question is answered or
  ends, the occupant changes, or the window closes.
- **The first answer wins, and a later one is told why.** A second answer
  while the first is being sent is refused with
  `native_question_being_answered`; one after a lead or Clankie answered is
  refused with `native_question_already_answered`. Who may answer is
  unchanged: a permission question still needs the worker's exact lead
  (ADR 0246), and owner questions still go to the owner's inbox.

## Consequences

- A busy lead may get a reminder for a question it is about to answer; the
  reminder says to ignore it then.
- A Codex question that stays open past the nine-minute window gets no more
  reminders; the owner can still answer it in the pane.
- The refusal reasons that tell a lead it lost are kept only for the current
  run of the service; after a restart a late answer reads as resolved.
