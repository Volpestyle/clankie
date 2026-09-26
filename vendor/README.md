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

The workspace-routing update (VUH-1377) pins upstream `e93dc70` and carries only
`672eb6f` (workspace routing) and `6637756` (explicit unlimited budgets) as its source patch. This also advances the older bundled candidate past
`bf910a1` / `e93dc70`: legacy v1 CLI, legacy-import/migration-cutover tools and their
skill references are removed; the compact coordinator and offline maintenance CLI
remain. Clankie's consumers use the coordinator entries, never the retired ones.

This advances coordination databases from schema 13 to 14. Back up each live DB
with SQLite's backup API before a coordinated owner/service upgrade; do not copy
a live WAL database file or replace running workers. Verify migration on a backup
copy. Old binaries refuse schema 14, so rollback requires the pre-upgrade backup
and reconciling any later work, not just replacing the binary. VUH-1344's older
legacy-migration/rollback acceptance requires an explicit upstream decision.
