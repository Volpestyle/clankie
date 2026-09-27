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

The current artifact is built directly from upstream `0981253`, with no local
source patch. It includes authenticated worker MCP readiness, fenced task reclaim,
long-transcript/subagent delivery fixes, launch-bound POSIX cancellation proof,
obsolete control-message expiry, configurable assignment progress deadlines,
idle owner retirement, backlog diagnostics, and the Claude/Codex launcher CLIs.
`swarm-mcp.patch` is intentionally empty; provenance pins the complete source.

This update retains schema 14. Back up each live DB with SQLite's backup API
before a coordinated owner/service upgrade; never copy a live WAL database.
Older schema-13 installations still need the documented migration backup.
Windows and legacy workers without termination receipts retain the cooperative
stop-proof boundary; an absent pane or expired lease does not release capacity.
The interactive-worker schema-15 branch is not part of this artifact.
