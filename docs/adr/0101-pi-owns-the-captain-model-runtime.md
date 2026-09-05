# ADR 0101: Pi owns the captain model runtime

Status: accepted (James, 2026-08-15). Amended by
[ADR 0152](0152-a-harness-takes-the-operator-seat.md) (2026-09-01): pi owns the
model runtime for the pi lanes. A harness in the operator seat runs on its own
model; `clankie model` and `/effort` change the service lanes, and the seat's
harness owns its own selection. Amended again 2026-09-04 (VUH-1103): Pi's
catalog is authoritative only for the models it has; a configured effort now
fails by name instead of clamping. See "Two catalogs, one selection" below.

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

## Two catalogs, one selection (2026-09-04, VUH-1103)

Pi's catalog ships inside `@earendil-works/pi-ai` and lags models.dev, so "the
primary picker comes from Pi" made every model newer than the installed pi
release unselectable for the captain while the AI SDK adapters accepted it.
`gpt-6-astra` was absent from pi-ai 0.84.2 and stayed absent after a forced
pi.dev refresh.

Pi therefore owns the transport, not the membership question. A model Clankie's
catalog knows and Pi's does not is filled for `openai` and `openai-codex` from
the catalog entry (`piModelsFor`, `piModelFor`), riding the newest dated sibling's `api`, `baseUrl`, and
capability `compat` — dated, because Pi's bundled files run oldest-first and the
oldest model carries the least capable flags. Pi's own entry wins wherever both
know a model. An id the provider cannot serve is still refused by the backend,
with the backend's own reason.

Other providers keep Pi's explicit model membership. Aggregators such as
`opencode` and `opencode-go` route different models through different APIs and
URL paths, and models.dev does not identify that transport. Filling them from
one sibling would send some models over the wrong protocol.

A configured effort the model has no tier for is now refused by name on both
adapters. Clamping is still right for the unset default; for a configured value
it answered with a quiet downgrade the receipt then reported as the selection,
which is the undisclosed fallback selection is supposed to be free of.

Clankie's own catalog only moves when something fetches — `catalog()` never
touches the network — so `clankie model refresh` is the headless half of the
TUI's "refresh model catalogs", and the not-in-either-catalog failure names it.

## Consequences

- A model shown by the primary picker is executable by the captain.
- Pi clamps `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` to the
  selected model's supported ladder when no effort is configured; a configured
  effort outside that ladder is an error naming the ladder, on both adapters.
- ChatGPT subscription precedence resolves before the Pi model is selected.
- OAuth refresh uses the shared Keychain broker and preserves account metadata.
- `pnpm --filter @clankie/clankie verify-model` drives one selection down all
  three executors — captain tool + image, gameplay action, play commentary —
  against a throwaway config, and is how a model is accepted across them.
