# Public docs

This app builds the public product documentation served from
[`docs.clankie.bot`](https://docs.clankie.bot). It leads with Clankie — who he
is, how to install him, how to reach him from the app — and then renders the
technical references from their canonical files at build time, so the site
cannot drift from what ships.

| Page             | Source                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`              | `site/index.html`, hand-authored                                                                                                                        |
| `/how-it-works/` | `content/how-it-works.md`, a product-depth digest of [`docs/architecture.md`](../../docs/architecture.md)                                               |
| `/console/`      | `content/console.md` plus the slash-command literals in `apps/tui/src` and the Workspaces and Operator behavior sections of the TUI README              |
| `/cli/`          | [`docs/cli.md`](../../docs/cli.md)                                                                                                                      |
| `/api/`          | [`apps/clankie/openapi.yaml`](../../apps/clankie/openapi.yaml), also served raw at `/api/openapi.yaml`                                                  |
| `/network/`      | `site/network/index.html` with the route table rendered from [`packages/protocol/src/public-gateway.ts`](../../packages/protocol/src/public-gateway.ts) |
| `/llms.txt`      | Generated index of the pages above and the repository                                                                                                   |
| `/llms-full.txt` | Every rendered page plus `docs/architecture.md`, as one Markdown document                                                                               |

`scripts/build.mjs` copies `site/` to `dist/`, adds the product logo, fills the
shared header nav into every page, renders Markdown with `marked`, parses the
OpenAPI document with `yaml`, and rewrites repository-relative links to GitHub.
The build fails closed when a public route lacks a description, when a console
command is registered in a shape the extractor cannot read, or when a README
section it slices has moved.

```bash
pnpm --filter @clankie/docs check
pnpm --filter @clankie/docs build
open apps/docs/dist/index.html
```

Keep public product guidance here. Contributor-depth documentation stays under
the repository's `docs/`; the site renders the operator references from there
rather than copying them. [ADR 0155](../../docs/adr/0155-public-docs-are-a-product-surface.md)
records the product boundary and deployment ownership, and
[ADR 0156](../../docs/adr/0156-the-docs-site-renders-the-canonical-references.md)
the identity and the rendered references.
