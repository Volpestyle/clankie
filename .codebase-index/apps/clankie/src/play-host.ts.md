# apps/clankie/src/play-host.ts

Asked embodiment's executing half (ADR 0063).
`PlayHost` polls the embodiment seam for work
(`claimEmbodiment` every 1s), runs a claimed
start detached via the injected `PlayExecution`,
and reports every lifecycle transition back —
polling continues during play so a stop ask can
land mid-playthrough.

Key behavior:

- `onRunning` fires exactly once after lock +
  boot succeed; only then is "he is playing"
  reported (with resume lineage).
- `reconcile()`: a live session attributed to
  this runner that this process does not hold
  is a previous process's corpse — reported
  failed with a `lease_lapsed` receipt (or
  refused if it never ran) so the next ask is
  not blocked by a ghost. Another runner's
  session is left alone.
- Claim-poll failures log once per error
  signature plus one recovery line — never
  silent, never spam.
- `stopAndWait({ deadlineMs })`: bounded
  shutdown; on deadline expiry it publishes an
  explicit failed terminal state (with a small
  grace for the report itself) and ignores a
  late clean settlement so the record stays
  truthful.
- A double-assigned start is refused
  `body_held` rather than run beside the first;
  lost reports are logged and left to
  reconcile/stale-expiry.
