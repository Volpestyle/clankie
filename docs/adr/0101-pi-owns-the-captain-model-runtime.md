# ADR 0101: Pi owns the captain model runtime

Status: accepted (James, 2026-08-15).

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

Gameplay, voice, image, and video adapters keep their AI SDK paths. They consume
roles from the same Clankie config, but they are different APIs that Pi's coding
agent runtime does not replace.

## Consequences

- A model shown by the primary picker is executable by the captain.
- Pi clamps `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` to the
  selected model's supported ladder.
- ChatGPT subscription precedence resolves before the Pi model is selected.
- OAuth refresh uses the shared Keychain broker and preserves account metadata.
