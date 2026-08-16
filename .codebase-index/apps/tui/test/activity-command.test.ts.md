# apps/tui/test/activity-command.test.ts

Covers `formatActivityObservation` (playing/pending/
not_playing renderings, authored-vs-observed
labelling, watch URL) and the `/activity` command
wiring. Notably asserts control-sequence stripping:
a model-authored intent embedding an OSC 52 escape
renders as plain spaces, never terminal control.
