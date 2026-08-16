# apps/tui/src/shell/command-log.ts

Transcript blocks for slash-command outcomes: a
`done /cmd command` (or `error /cmd command`) header
with an indented, lightly styled body — `Label:`
prefixes in yellow, Usage/Examples dimmed.
`ClankieCommandTextResultComponent` renders a plain
text body; `ClankieCommandResultComponent` wraps
another component (e.g. a dashboard view). Ported
from v1.
