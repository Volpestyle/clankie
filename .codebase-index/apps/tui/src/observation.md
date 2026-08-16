# apps/tui/src/observation

Live operator-surface observations and Herdr companion control.

- `presence.ts` — 5s read-only service presence poller.
- `herdr-roster.ts` — 5s sibling-pane roster, inert outside Herdr.
- `herd-lead-companion.ts` — open/inherit/focus/close the labelled `Herd Lead` pane with this console as jump-back peer.

Pollers use unref'd timers and notify only on changes; companion operations are injectable and return explicit unavailable outcomes.
