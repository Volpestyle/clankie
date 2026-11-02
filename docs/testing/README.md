# Testing records

Repeatable CI and local checks: [quality gates](quality-gates.md).

James-triggered trust and delivery checks: [manual failure scenarios](manual-failure-scenarios.md).
These scenarios are outside CI, `pnpm check` and release gates.

Dated verification and evaluation records live here when the evidence is useful
beyond a single CI run.

## Viewer

The dependency-free archive viewer indexes, hashes, and serves every file in an
entry without requiring per-run UI files or a manifest. It automatically adds
an image gallery for PNG/JPEG/GIF/WebP/AVIF/SVG captures, native video playback,
searchable text sources, binary metadata, and the causal turn inspector when a
play journal exists.

```bash
# Latest dated archive
pnpm testing:view

# Any selected archive; --check runs the server/security smoke test and exits
pnpm testing:view docs/testing/2026-11-02-issue-287-regression-audit
pnpm testing:view docs/testing/2026-11-02-issue-287-regression-audit --check
```

An archive only needs its normal `README.md`, `evidence/`, and `flows/`
contents. The viewer derives its title from the README heading and discovers
all other capabilities from the files present.

## Publishing raw evidence

Raw captures belong in the evidence store, not in git
([ADR 0258](../adr/0258-evidence-lives-in-the-evidence-store.md)). Write the
folder's `README.md`, then run `clankie evidence push <folder> --issue <KEY>`
(or the `evidence_push` MCP tool). It uploads media and other non-Markdown files
of 16 KiB or more, writes the folder's `evidence.json` manifest, and moves the
raw files into the ignored `.local/evidence/` mirror. Commit only the README and
`evidence.json`, and cite the printed `clankie://evidence` links. Readers run
`clankie evidence fetch <folder>`. See [the CLI reference](../cli.md) for the
details. Existing folders have not been migrated yet, and the viewer does not
read the `.local/` mirror yet.

## Current records

- [2026-11-02 Surviving Codex report admission (#288)](2026-11-02-restart-report/README.md)
- [2026-11-02 #287 post-merge regression audit](2026-11-02-issue-287-regression-audit/README.md)
- [2026-11-02 Issue #280: main checkpoint close-out proof](2026-11-02-issue-280-main-checkpoint/README.md)
- [2026-11-02 Codex hire cwd (#252)](2026-11-02-codex-hire-cwd/README.md)
- [2026-11-01 #265: a landed hire's close removes its worktree](2026-11-01-issue-265-close-worktree/README.md)

## Archive

Records dated before 2026-11-01, and the undated Linear-era `vuh-*` records,
moved to the private `Volpestyle/clankie-ops` repository under
[`archive/clankie-docs-testing/`](https://github.com/Volpestyle/clankie-ops/tree/main/archive/clankie-docs-testing)
as a plain copy of clankie commit `44c53e19d`. Their history stays in this
repository's git log. Links elsewhere in this repository point at the archived
copy.
