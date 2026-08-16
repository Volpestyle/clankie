# apps/clankie/src/captain/herdr-seat.ts

`operatorPromptWithHerdrSeat()` enriches an operator prompt only when the TUI supplies a Herdr pane id. It frames that pane as Clankie's seat and appends the current session census; socket-only turns pass through unchanged.
