# Public docs

This app builds [docs.clankie.bot](https://docs.clankie.bot), the shared field
guide for hosted customers and people running Clankie themselves. The
[repository README](../../README.md) speaks directly to DIY users. The landing
page at [clankie.bot](https://clankie.bot) leads with everyday usefulness and
owns hosted plans, app availability, privacy, and support.

## Reader paths and voice

Lead with what a person wants to do: talk, remember, make something, or finish a
larger job. Technical readers should find models, skills, agent runtimes, and
APIs quickly. Keep those paths connected without requiring agent terminology
before the first conversation.

The visual language comes from Clankie's existing identity: the sprout robot,
pixel art, garden greens, warm cream and gold, readable serif headings, and
quiet motion. Keep functional labels plain. The promo is an introduction, not
a support matrix: distinguish a configured Mac capability from the hosted
product's offering, and activity from verified results.

Setup steps belong in `get-started.md`; everyday behavior in `using-clankie.md`;
optional customization in `diy.md`; system concepts in `how-it-works.md`.
`reference.md` is a task-oriented index into canonical contracts. Do not copy
prices, release channels, or full command catalogs into those guides.

## Sources

| Page              | Source                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`               | `site/index.html`, hand-authored                                                                                                                        |
| `/get-started/`   | `content/get-started.md`: hosted onboarding and DIY installation/pairing                                                                                |
| `/using-clankie/` | `content/using-clankie.md`: everyday use, memory, making things, and the app                                                                            |
| `/diy/`           | `content/diy.md`: models, skills, agents, integrations, and extension points                                                                            |
| `/reference/`     | `content/reference.md`: links by task into the canonical library                                                                                        |
| `/how-it-works/`  | `content/how-it-works.md`, a product-depth digest of [`docs/architecture.md`](../../docs/architecture.md)                                               |
| `/console/`       | `content/console.md` plus the slash-command literals in `apps/tui/src` and the Workspaces and Operator behavior sections of the TUI README              |
| `/cli/`           | [`docs/cli.md`](../../docs/cli.md)                                                                                                                      |
| `/api/`           | [`apps/clankie/openapi.yaml`](../../apps/clankie/openapi.yaml), also served raw at `/api/openapi.yaml`                                                  |
| `/network/`       | `site/network/index.html` with the route table rendered from [`packages/protocol/src/public-gateway.ts`](../../packages/protocol/src/public-gateway.ts) |
| `/llms.txt`       | Generated index of the pages above and the repository                                                                                                   |
| `/llms-full.txt`  | Every page plus `docs/architecture.md`; static pages retain their semantic HTML inside Markdown                                                         |

`scripts/build.mjs` copies `site/` to `dist/`, adds the product logo, fills the
shared header nav into every page, renders Markdown with `marked`, parses the
OpenAPI document with `yaml`, and rewrites repository-relative links to GitHub.
The build fails closed when a public route lacks a description, when a console
command is registered in a shape the extractor cannot read, or when a README
section it slices has moved.

## Build and preview

```bash
pnpm --filter @clankie/docs check
pnpm --filter @clankie/docs build
python3 -m http.server 8767 --bind 127.0.0.1 --directory apps/docs/dist
```

Open `http://127.0.0.1:8767/` to preview. Serve over HTTP: root-relative
assets and page links do not resolve from a `file:` URL. Check narrow phone,
tablet, and desktop layouts, keyboard focus, and the reference tables.

The machine-readable export uses each page's canonical content, including the
static home and network pages; it does not keep another network summary in
the build script. The public check verifies generated links and anchors.

Keep public product guidance here. Contributor-depth documentation stays under
the repository's `docs/`; the site renders the operator references from there
rather than copying them. [ADR 0155](../../docs/adr/0155-public-docs-are-a-product-surface.md)
records the product boundary and deployment ownership, and
[ADR 0156](../../docs/adr/0156-the-docs-site-renders-the-canonical-references.md)
the identity and the rendered references.
