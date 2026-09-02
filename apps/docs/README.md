# Public docs

This app builds the public product documentation served from
[`docs.clankie.bot`](https://docs.clankie.bot). The authored static pages live
under `site/`; `scripts/build.mjs` copies them to `dist/`, adds the product logo,
and renders the public gateway table from
[`packages/protocol/src/public-gateway.ts`](../../packages/protocol/src/public-gateway.ts).

```bash
pnpm --filter @clankie/docs check
pnpm --filter @clankie/docs build
open apps/docs/dist/index.html
```

Keep public product guidance here. Contributor and operator-depth references
remain under the repository's `docs/`, and the site links to those canonical
sources instead of copying them. [ADR 0155](../../docs/adr/0155-public-docs-are-a-product-surface.md)
records the product boundary and deployment ownership.
