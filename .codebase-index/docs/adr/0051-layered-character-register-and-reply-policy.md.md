# docs/adr/0051-layered-character-register-and-reply-policy.md

Identity is three layers with different owners:
character (owner-authored persona in
`@clankie/settings`, edited via `/persona`),
operating contract (repo-owned instructions), and
register (derived from the authenticated lane:
operator / social / gameplay).

Read for the load-bearing rules: persona is never
supplied by callers or channel metadata; every
rendered persona ends with "voice changes with
the room, permission never does"; the free-play
prompt must not define identity (character
composes first); `persona.replyPolicy`
(`addressed` default | `all`) is evaluated before
the turn so staying quiet costs no model call.
Possession does not inherit the character (ADR
0053 is authoritative there).
