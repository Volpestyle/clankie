# apps/tui/src/memory-commands.ts

Builds `/memory` commands over the operator-only memory API. The command renders the full catalog and provides guided edit/delete flows for captain episodes and Discord person facts, including confirmation before destructive changes.

`formatMemoryCatalog()` produces the compact terminal report used by the shell.
