---
name: tidy
description: Tidy finished Clankie worker panes after harvesting, or when asked to tidy up. Judge their work and reports before closing; preserve owner drafts and interactive panes.
quick-action:
  name: Tidy up
  icon: broom
  selectionArg: selection
---

# Tidy the fleet

Read the current roster, the selected panes if any, and their reports. Decide
which workers have finished useful work and whose results are kept. A settled
status is a cue to inspect, not proof of completion. Keep a worker around when
follow-up work would benefit from its live context. You can tidy after harvesting
without waiting for the owner to list panes or approve each close.

Use `close_worker_pane` for each pane you judge finished, with a short one-line
reason and its saved report path when available. The service preserves its last
output and report in `worker_pane_history`, and returns an undo ID with a short
deadline. `undo_worker_pane` reopens and resumes that session.

The service protects unsent drafts, owner-interactive or hand-started panes you
did not hire, and results not kept. Unknown draft state or provenance is a
technical failure: leave that pane alone and explain the gap. A missing Herdr
session on a reattached pane is not evidence that the worker is finished or that
its results are lost. Never bypass a refusal with raw pane-close or keystrokes.

Say what you closed and why in the conversation you are working in, and offer
the returned undo IDs and deadlines. Name any panes you left because of a
refusal or uncertainty. If the owner stops the turn, stop tidying.
