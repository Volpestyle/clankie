# Unreleased

Connector sign-ins are sturdier. An app's name must be readable text, and through
the doorway each requester keeps at most four waiting sign-ins, so one busy client
can't crowd out another. Its next sign-in replaces its oldest waiting one.

A board note can name the leads it is for. `post_note` takes `to` (`clankie`, or
a lead with a stored wake webhook such as `duet` or `grok`). Each one is woken
once: at its webhook, or, if that doesn't take it, through Clankie's lead lane
(his live lead pane, else his model, which keeps it while the apps lead). The
post and every board read show how each lead was reached.
`clankie connector notes` shows the board with those receipts (#179).
One app's notes wake Clankie's lane at most 6 times in 10 minutes; past that a
note still posts, and its receipt says the wake was `limited` (#625).

The owner's paired app can mark finished built-in work as working, or send it back
with a note, through the new `post_owner_verdict` tracker write (ADR 0299). Only
a Take Control device the owner paired locally may call it; agents, the operator
credential and devices paired through a hosted account are refused for now.
Only items the lead or the owner marks with a one-line `ownerCheck` on
`save_issue` ask the owner to check them; workers can't set it (ADR 0299).

Idle hired seats can restart fresh at 450K context tokens after saving a handoff.
`seatRestarts` defaults to **on**, including existing installations after upgrade.
Use `clankie fleet set --seat-restarts off` or `/fleet` to turn it off. This setting
is independent of lead-seat restarts. Claude hires and default local Codex
launches also receive a 500K native compaction backstop; custom and remote Codex
launchers keep their configured windows.
