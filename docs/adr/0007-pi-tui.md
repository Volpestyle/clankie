# ADR 0007: Use @earendil-works/pi-tui for the operator TUI

Status: accepted.

The TUI uses the package from `earendil-works/pi/packages/tui`, including its `TUI`, `ProcessTerminal`, component, overlay, editor, settings, keybinding, and width-safe rendering primitives. The app owns product components and state projections while keeping the framework dependency behind a small UI layer.
