# packages/model-provider/src/variants.ts

Reasoning presets. `ModelVariant` is data: an id
plus provider _wire-format_ body/headers
(snake_case); lowering to AI SDK providerOptions
happens at generate time in instantiate.ts.

`effortVariantsFor(providerId, model)` — empty
for non-reasoning models; otherwise by family:

- openai family (openai / openai-codex / azure /
  openai-compatible): the model's documented
  `reasoning_effort` ladder from the
  `OPENAI_EFFORTS` pattern table (first match
  wins; -pro models narrower than their base
  sibling; gpt-5.6 reaches `max`, gpt-5 still has
  `minimal`; the Codex client's `ultra` tier is
  deliberately absent — the backend rejects it
  for this originator), falling back to
  low/medium/high for unknown models since
  under-offering only hides an option while
  over-offering fails the request.
- anthropic: think-8k/16k/32k thinking budgets.
- xai: low/high. google: thinkingConfig budgets.
- other reasoning providers: low/medium/high.

`variantById` finds a variant by id.
