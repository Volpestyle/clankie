---
name: maintain-docs
description: Use when a change alters what Clankie does, is called, or how he is reached, and before a release, to find and update every human-facing surface that describes it - docs.clankie.bot, the clankie.bot landing page, READMEs, docs/, ADR diagrams, and the app's docs - and to audit them for drift.
---

# Maintain Clankie's docs

Clankie is described in four repositories. A change lands in one; the words
that describe it often live in another. Find every surface that states the
changed fact, fix it at its source, and let generated surfaces rebuild.

## Surfaces

| Surface                                 | Source                                                                                                                                                                                                      | Deploys                                     | Check                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------- |
| `docs.clankie.bot`                      | `apps/docs` here: `site/index.html` and `content/*.md` hand-authored; `/cli/`, `/api/`, `/network/`, console commands rendered from canonical files ([`apps/docs/README.md`](../../../apps/docs/README.md)) | `docs.yml` on push to `main`, path-filtered | `pnpm docs:check`         |
| Repo docs                               | `README.md`, app/package READMEs, `docs/*.md`                                                                                                                                                               | not deployed; GitHub                        | `pnpm docs:check` (links) |
| ADRs                                    | `docs/adr/`; conventions in its [README](../../../docs/adr/README.md)                                                                                                                                       | —                                           | links                     |
| `clankie.bot` landing, privacy, support | `~/dev/clankie-landing` (separate public repo, static HTML, no build)                                                                                                                                       | its `deploy.yml` on every push to `main`    | open the page             |
| App docs                                | `~/dev/clankie-app` README and `docs/` (private)                                                                                                                                                            | —                                           | that repo's checks        |
| Hosted-service records                  | `~/dev/clankie-ops/docs` (private)                                                                                                                                                                          | —                                           | that repo                 |

Privacy and support URLs are App Store metadata: they live on the landing site
and the docs site links to them rather than copying policy text (ADR 0155).
Hosted, business, and launch facts stay in `clankie-ops`; never move them into
this public repo or the landing page's source comments.

Generated pages rebuild from their sources. Fix `docs/cli.md`,
`apps/clankie/openapi.yaml`, `packages/protocol/src/public-gateway.ts`, or the
TUI README, never `apps/docs/dist`. `how-it-works.md` is a hand-written digest
of [`docs/architecture.md`](../../../docs/architecture.md), so a change to one
needs a read of the other.

## Diagrams

Current-state diagrams are Mermaid in the owning Markdown, and they change in
the same commit as the architecture they draw. The `docs/diagrams/*.jpg`
exports are dated historical records of the decision that cites them: do not
update them to match today's system, and never hand-edit or fabricate a render.
Each export's editable source is a page of the same name in one of the
`.tldraw` files listed in the [ADR README](../../../docs/adr/README.md#diagram-sources)
(`clankie-docs-diagrams.tldraw` and `-2` hold one page per diagram). Use the
`tldraw-offline` skill to edit one; add a tldraw source only for a decision
that spans repos, and list it in that table.

## Voice

- Every human-read string says **Clankie**, never "captain". Identifiers,
  routes such as `/v1/captain/...`, and `captain.*` event types keep the old
  name; prose around them does not.
- Lead with Clankie, the persistent agent with a personality. The app is half
  the product and gets its own first-class section, never a co-equal "two ways
  in" identity (ADR 0156).
- Retired systems stay out of current-tense prose: missions, the doctrine
  contract, the control plane/runner split, the in-repo emulator and mGBA core
  (ADR 0145), and the app's canvas view. ADRs and dated test records may keep
  describing them as history. The garden and the commons are the same living
  room of agent sprites; either name is fine.
- Say what ships. Mark a gated or planned capability as such; do not describe
  an unmerged or undeployed change as available.

## With a change

Before handoff, search every surface above for the names, commands, routes,
and settings the change adds, renames, or removes, including the neighbor
checkouts:

```bash
rg -n -i '<old name>|<new name>' README.md docs apps/*/README.md packages/*/README.md \
  apps/docs/site apps/docs/content ~/dev/clankie-landing/*.html ~/dev/clankie-app/README.md
```

Update the owning text in the same change when it is in this repo. A fact that
lives in a neighbor repo is that repo's change: make it there with its own
checks, or tell the owner what now reads wrong. Landing copy and visuals are
marketing and taste; propose them to James rather than rewriting them.

## Drift audit

Run before each release (`release-clankie`) and when asked:

1. List what changed since the last release:
   `git log --oneline $(git describe --tags --abbrev=0)..HEAD`, plus user-visible
   commits in `clankie-app` and `clankie-landing` over the same window.
2. For each user-visible change, check the surfaces above say it correctly.
3. Search the public surfaces for retired vocabulary and read each hit in
   context; identifiers and history are fine:
   `rg -n -i -w 'captain|mission|doctrine|emulator|mgba' apps/docs/site apps/docs/content README.md ~/dev/clankie-landing/index.html`
4. Diff `docs/architecture.md` against `apps/docs/content/how-it-works.md`.
5. Run `pnpm docs:check`, then build and open the site
   (`pnpm docs:public:build && open apps/docs/dist/index.html`).
6. Fix what this repo owns; report the rest with file and line to its owner.
