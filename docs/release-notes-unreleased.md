# Unreleased

The owner's paired app can mark finished built-in work as working, or send it back
with a note, through the new `post_owner_verdict` tracker write (ADR 0299). Only
the owner's own Take Control device may call it; agents and the operator
credential are refused.

Idle hired seats can restart fresh at 450K context tokens after saving a handoff.
`seatRestarts` defaults to **on**, including existing installations after upgrade.
Use `clankie fleet set --seat-restarts off` or `/fleet` to turn it off. This setting
is independent of lead-seat restarts. Claude hires and default local Codex
launches also receive a 500K native compaction backstop; custom and remote Codex
launchers keep their configured windows.
