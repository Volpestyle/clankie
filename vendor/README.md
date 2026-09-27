# Bundled Swarm and leadership skills

These immutable npm artifacts make a checkout and a packaged install use the same
runtime and skills. The public `swarm-mcp` npm release is the legacy runtime;
Clankie uses the v2 candidate plus its embedding and Herdr integration.

- `swarm-mcp-2.0.0-rc.1.tgz`: built source from `~/dev/swarm-mcp`.
- `volpestyle-lead-skills-0.1.1.tgz`: `lead`, `swarm-lead`, `herdr-lead` and its
  references, from `~/dev/skills/agent`, with the source repository's MIT license.
- [provenance.json](provenance.json): base revisions and artifact SHA-256 digests.
- `swarm-mcp.patch`: the complete source delta against the pinned Swarm base,
  including new files. Apply it in a clean checkout to reproduce the source.

Edit the source repositories, then rebuild the artifacts. For Swarm, run
`bun install --frozen-lockfile`, `bun run build`, `npm run verify:package`, and
`npm pack --ignore-scripts --pack-destination /path/to/clankie/vendor`.
For skills, stage `agent/package.json`, the three skill directories and root
`LICENSE` in a temporary directory; run the same `npm pack` command there.
Update source provenance, then install the artifact only in a coordinated runtime
upgrade window. **Do not run `pnpm install` against a changed Swarm artifact in
the service checkout while dispatched workers may still be live.** Hold new
dispatch, inventory every affected coordinator scope and uncertain launch, and
have the lead reconcile/drain the workers before replacement. Take fresh online
database backups and coordinate the owner/service restart so new workers and
owners use one compatible build. A package install is not a running-owner
upgrade. The current tooling does not enforce this preflight automatically;
[incident evidence and planned safeguards](../docs/testing/2026-09-26-interactive-swarm-workers/startup-incident.md)
explain the mixed-build startup failure. The skill archive itself includes its complete Markdown sources.

Clankie's product skill links resolve into its installed packages. Global personal
skill links continue to resolve to the original source repositories. Release
assembly dereferences product links and copies Swarm's dependency graph; an
installed release needs no sibling checkout or globally installed npm package.

The candidate artifact is built from Swarm `a72a2d3`, based on pushed upstream
`0981253`. `swarm-mcp.patch` reproduces the complete committed source delta;
`provenance.json` pins both revisions and checksums. This candidate adds managed
Codex (`gpt-6-astra`) and pi worker adapters, per-launch MCP configuration, and
persisted harness selection. The first installed candidate (`b62a68f`) failed both
live canaries. This repair corrects Codex override keys, explicitly preapproves only
its enrolled `swarm_inbox`/`swarm_task` lifecycle tools, and preserves stop authority
for disabled routes. Pi's missing client dependency is now included in the lockfile
snapshot; the former hash-only update retained an incomplete dependency graph.
Clean production-package and real-binary fixtures are separate from the required
live Clankie canaries; install and owner/service restart remain lead-controlled.

This candidate advances schema 14 to schema 15 with `dispatch_intents.harness`.
Back up each live DB with SQLite's backup API before the coordinated upgrade;
never copy a live WAL database. The separate, unmerged interactive-worker branch
also labels its mode-column migration schema 15. These schema-15 builds are NOT
interchangeable: integration must sequence both migrations under distinct versions.
The interactive-worker branch is not part of this artifact. Remote peers continue
to enroll through the shared coordinator relay; this adds no private PC owner.
