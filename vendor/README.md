# Bundled Swarm and leadership skills

These immutable npm artifacts make a checkout and a packaged install use the same
runtime and skills. The public `swarm-mcp` npm release is the legacy runtime;
Clankie uses the v2 candidate plus its embedding and Herdr integration.

- `swarm-mcp-2.0.0-rc.1.tgz`: built source from `~/dev/swarm-mcp`.
- `volpestyle-lead-skills-0.1.0.tgz`: `lead`, `swarm-lead`, `herdr-lead` and its
  references, from `~/dev/skills/agent`, with the source repository's MIT license.
- [provenance.json](provenance.json): base revisions and artifact SHA-256 digests.
- `swarm-mcp.patch`: the complete source delta against the pinned Swarm base,
  including new files. Apply it in a clean checkout to reproduce the source.

Edit the source repositories, then rebuild the artifacts. For Swarm, run
`bun install --frozen-lockfile`, `bun run build`, `npm run verify:package`, and
`npm pack --ignore-scripts --pack-destination /path/to/clankie/vendor`.
For skills, stage `agent/package.json`, the three skill directories and root
`LICENSE` in a temporary directory; run the same `npm pack` command there.
Update source provenance and run `pnpm install` in Clankie after replacing an
artifact. The skill archive itself includes its complete Markdown sources.

Clankie's product skill links resolve into its installed packages. Global personal
skill links continue to resolve to the original source repositories. Release
assembly dereferences product links and copies Swarm's dependency graph; an
installed release needs no sibling checkout or globally installed npm package.
