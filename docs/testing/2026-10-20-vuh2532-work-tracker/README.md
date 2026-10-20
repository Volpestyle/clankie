# VUH-2532 — Work tracker settings

Tracks: https://linear.app/vuhlp/issue/VUH-2532

The CLI transcript runs the production CLI against an isolated source service
using the scratch-stack broker-operator preset. Its test project is a separate
Git repository. No real project's tracker or installed runtime was changed.

The transcript shows the global default, fresh-project creation using that
default, project settings, refusal without confirmation, a switch from built-in
to repo files, and a switch back. The original built-in item reappears; the
repo-file item remains in its original directory. Existing items never migrate.

Focused integration checks cover retained items, stale previews, disconnected
GitHub refusal, owner authorization, and the new-project default. The project
and onboarding regression run passed 90 tests. The legacy binding API also refuses changes
that would bypass the new confirmation for an active built-in tracker.

UI captures and app verification are pending the core landing. Linear/GitHub
sign-in is reused from connected accounts; no new external account was connected
for these proofs. Discord forum remains planned in VUH-2531.
