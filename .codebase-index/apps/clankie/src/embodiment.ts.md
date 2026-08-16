# apps/clankie/src/embodiment.ts

Asked embodiment's authority half (ADR 0063).
`EmbodimentManager` holds intent, authority, and
the durable session lifecycle; it never touches
the emulator. The play host claims work from it
and reports transitions back; the captain's
tools submit intents and poll.

Every state change is an emitted event applied
back through `applyEvent()` — the same path
replay uses on boot — so restart rebuilds the
exact live state. All mutating entry points
serialize through one promise queue (one body,
never double-booked).

Behavior worth knowing:

- `submit(start)`: the injected `decide()`
  verdict gates it (anything but "allow"
  refuses `policy`); a repeat start for the
  environment already playing answers with the
  live session (never-rejoin mirror); a
  different environment refuses `body_held`.
  Refused starts still mint a queryable session
  record.
- `submit(stop)` records stop_requested; the
  owning runner gets the stop re-delivered on
  every claim poll until a terminal report.
- `expireStale()`: requested/claimed sessions
  past the claim window (60s default) refuse
  `no_runner`; dead running sessions are the
  runner's to reconcile.
- `report()` validates runner identity and the
  legal-transition table before recording.

Also exports the embodiment event-type list,
`isEmbodimentEventType`, and
`embodimentEventScope()`.
