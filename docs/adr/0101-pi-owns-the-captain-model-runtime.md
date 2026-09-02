# ADR 0101: Pi owns the captain model runtime

Status: accepted (James, 2026-08-15). Amended by
[ADR 0152](0152-a-harness-takes-the-operator-seat.md) (2026-09-01): pi owns the
model runtime for the pi lanes. A harness in the operator seat runs on its own
model; `clankie model` and `/effort` change the service lanes, and the seat's
harness owns its own selection.

## Context

Clankie's TUI selected the primary model from the models.dev catalog while the
captain executed it through Pi's independent catalog. The same config could
therefore offer a model Pi did not know, and `/effort` wrote provider-specific
variants the Pi session never read.

## Decision

`clankie.json` owns model selection and provider allow/deny policy. The
credential broker owns persisted secrets. Pi's `ModelRuntime` owns the
captain's language-model catalog, provider implementation, auth resolution,
subscription transport, and thinking levels.

The TUI's primary `/provider`, `/model`, and `/effort` choices come from Pi.
Clankie custom provider declarations are projected into Pi with
`registerProvider`; Pi user files such as `~/.pi/agent/models.json` and
`settings.json` do not influence the service. Existing durable lanes apply a
changed model and thinking level on their next idle turn, never midway through
a steered run.

Gameplay and media adapters keep their AI SDK paths because Pi's coding-agent
runtime does not replace those APIs. Language-model adapters lower Pi's saved
effort to the provider's request shape and apply Pi's medium default, so gameplay
uses the same selected model and effort as the captain. Image and video retain
their explicit media-model refs.

## Consequences

- A model shown by the primary picker is executable by the captain.
- Pi clamps `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` to the
  selected model's supported ladder.
- ChatGPT subscription precedence resolves before the Pi model is selected.
- OAuth refresh uses the shared Keychain broker and preserves account metadata.
