# ADR 0192: Model routing by kind of task

Status: proposed (idea approved by James, 2026-09-26). Tracks [VUH-1375](https://linear.app/vuhlp/issue/VUH-1375),
a child of [VUH-1371](https://linear.app/vuhlp/issue/VUH-1371).

## Context

Every model call Clankie makes runs on one captain model. Most of those calls are
not work: a Discord room's small talk, deciding whether to answer at all, a
reaction. Paying for the owner's strongest model on every one is how a hosted
plan's included usage runs out, and it is why self-hosted owners with a metered
key hesitate to leave him in a busy room.

A learned router would decide per message which model a turn deserves. It is
unpredictable, hard to test, and it would take a judgment away from him that he
is better placed to make.

## Decision

Two tiers and a fixed purpose table, plus one volitional escape hatch.

1. **Purposes.** Every captain session and the play mind have a purpose, fixed
   when the session is built: `operator` (every operator conversation, wakes,
   watches and side conversations), `discord_social` (a Discord text or voice
   turn without machine tools), `discord_granted` (a Discord turn holding
   machine tools, and the Herdr watches it arms), and `gameplay` (the play mind
   and its commentary).
2. **Tiers.** `work` is the owner's chosen `model`. `routine` is
   `routing.routine_model`. By default only `discord_social` is routine: it is
   where most turns are small talk, and a turn there holds no shell to do real
   work with. `routing.purposes` overrides any purpose either way.
3. **Off by default.** Routing is on only when `routing.routine_model` is set.
   Off, every purpose resolves to `model` exactly as before.
4. **Resolved per turn, through the existing selection.** A routed ref goes
   through the same resolver as the captain's own: provider policy,
   subscription precedence and per-ref effort all apply. A routine ref that
   cannot be served fails the turn by name; it never falls back to the work
   model.
5. **Escalation, once per run, only when on.** With `routing.escalate`, a
   routine run moves to `routing.escalation_model` (default `model`) when:
   - he calls `escalate` because the turn turned out to be real work;
   - the run reaches `routing.routine_turn_limit` model calls (default 12)
     without finishing; or
   - the routine model fails with an error Pi retries, so the retry runs on
     the escalation model.

   The move happens inside the run: Pi reads the session model before every
   model call, so no prompt is replayed. The next run starts routine again. A
   permanent error (a bad request, a missing credential) does not escalate: a
   broken routine setting should surface, not quietly spend the bigger model.
   Every escalation is written to the session file and logged.

6. **Hosted bodies take routing from their bootstrap.** The fleet's optional
   `modelRouting` bootstrap field is written over the body's routing at every
   start. Plan gating (escalation on Pro only) is enforced by the fleet's model
   proxy; the body's setting is a convenience, not the boundary.

## Consequences

- `clankie model routing …` and the console's `/routing` configure it; the
  status card shows every purpose's tier and model from the same resolver a
  turn uses.
- Media, voice (realtime), and hired workers keep their own selections.
- Deciding whether to reply, reactions and small talk are not separate model
  calls in Clankie today; they are the social turn itself, which is why the
  purpose table routes that turn rather than inventing calls to route.
- Gameplay stays on the work model by default until a play evaluation shows a
  cheap model plays well enough.
- The model proxy must accept a second model and attribute cost per tier; the
  contract is in the hosted design doc's "Model routing" section.
