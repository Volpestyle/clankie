# packages/model-provider

Resolves owner model configuration, the model registry, and brokered credentials into AI SDK models and Pi provider declarations. It owns provider-specific OAuth adapters, subscription precedence, reasoning variants, secret rejection, and live Codex capability probing.

- `package.json` — provider dependencies and probe scripts.
- `README.md` — configuration and resolution architecture.
- `src/` — config, provider factories, Pi projection, OAuth, variants, and resolution.
- `test/` — provider, credential, OAuth, and variant tests.
- `tsconfig.json` — TypeScript configuration.
