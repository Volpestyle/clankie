# ADR 0190: Setup asks one question, then Clankie takes over

Status: accepted (James, 2026-09-25).

## Context

A new owner met a console that said "Try /auth, /provider, /model, /status,
/board — or type a prompt" on every launch, configured or not. Three commands
had to run in order before a first message could succeed, and none pointed to
the next. With no model, the first message failed; with a model but no key,
`doctor` still called the install healthy, because it only checked declared
endpoints. Meanwhile about fifteen optional rooms — Discord, voice, the phone,
pictures, games, Linear, workers — each lived behind its own command, which
made setup feel far larger than it is.

Only one thing is required: a captain model and something that signs it in.

## Decision

`captainReadiness` in `@clankie/model-provider` is the single answer to "can
he take a turn": a model is chosen, and a stored credential, a provider env
key, a declared endpoint, or the ChatGPT subscription serving an `openai/` ref
authenticates it. `doctor` reports it as `captain` and names a missing key as a
remediation.

`/setup` is where a new owner starts. When he cannot take a turn it asks how
he should think — a Claude, ChatGPT or SuperGrok subscription, an API key, a
local model, or a provider already signed in — then which of that provider's
models, newest first. Effort keeps its default. The console opens this on its
own whenever he is not ready, and the footer says
`no model yet · /setup` in place of the model until he is.

Once he can think, `/setup` is a checklist of his optional rooms, each showing
its current state and opening the command that already owns it. Nothing is
reimplemented. The last entry, and the end of first setup, drafts a message
asking Clankie to walk the owner through the rest. The owner edits or sends it.
Clankie reads `clankie doctor`, sets what is not secret through his launcher,
and sends the owner to the console wizard for anything secret. This is his
agency, not a script: he decides what to offer and when.

Gameplay defaults to off. A fresh install has no world credential, so an
advertised game only failed. `/games on` or `clankie games set on` enables it.
Existing settings files that store the value keep it.

## Consequences

- A fresh install reaches a working first message in two choices plus a
  sign-in.
- `/auth`, `/provider` and `/model` remain for changing one piece. The sign-in
  flows return the provider they connected, which is how `/setup` chains them.
- `doctor` now probes `codex` and `claude` on PATH, so the checklist can say
  whether he has workers to hire.
- Portals do not yet read readiness from the service. The app's first message
  on an unready Mac still fails with the service's own error until a service
  route exposes `captainReadiness`.
