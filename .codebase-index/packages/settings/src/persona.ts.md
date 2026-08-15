# packages/settings/src/persona.ts

Composes the character layer of the captain's
instructions. `PersonaRegister` is the room he is
speaking in — `operator` / `social` / `gameplay` —
derived from the captain lane, which is proven by
which credential authenticated the turn (a
Discord message can never claim the operator
register).

`characterNames(persona)` lowercases displayName
plus aliases for address detection.
`personaInstructions(persona, register)` renders:
the identity line, owner-authored character notes
verbatim, the per-register style rules (social:
participant not assistant; operator:
evidence-first about work, casual otherwise —
with a deliberately room-agnostic example noted
inline; gameplay: stay in the moment, chat is
conversation not control), the chattiness line,
and the closing load-bearing invariant that voice
changes with the room but authority never does.
