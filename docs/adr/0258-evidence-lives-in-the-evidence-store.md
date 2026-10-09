# ADR 0258: Evidence lives in the evidence store

Status: proposed (2026-10-09). Tracks [VUH-1902](https://linear.app/vuhlp/issue/VUH-1902).
The first slice of the built-in tracker ("Clankie Work"); its evidence bundles
reference the records defined here.

## Context

[ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md) asks for proof by
the real thing, recorded as evidence. Workers record it as dated folders under
`docs/testing/`: a `README.md` narrative with screenshots, raw run JSON and logs
committed beside it. On 2026-10-09 clankie's `docs/testing` held 20 MB and
about 165k lines in git: 103k lines of JSON/JSONL, 19k of Markdown, 123 PNGs.
James's audit puts clankie-app at about 294 MB of evidence media in `artifacts/`
and `docs/` (841 files, a 202 MiB pack) and clankie-ops at about 43 MB.

Large raw JSON pollutes agent search results and context. Every worktree checks
out every capture. On 2026-10-08, dozens of worktrees plus fseventsd and
Spotlight indexing were a real cost on this Mac (VUH-1871, VUH-1899). The
tracker can only point at repo paths; it cannot hold the media.

## Decision

Git keeps narratives, conclusions and pointers. The evidence store keeps the
bytes and the records that describe them.

**Scope.** Evidence objects are media (png, jpg, gif, mp4, mov, webm) of any
size, and any other non-Markdown file of 16 KiB or more: raw eval/run JSON,
JSONL journals and logs. Markdown and smaller text stay in git. At 16 KiB, 46
non-media files in clankie's `docs/testing` move, carrying 89k of their 118k
lines; about 600 small receipts and fixtures stay readable in place.

**Service.** The store is a Rust `axum` service in this monorepo
(`apps/evidence-store`, beside the Rust `apps/vox`). Blobs are keyed by their
sha256, so identical files are stored once and every upload is idempotent.
Blobs are immutable, and nothing deletes them in this slice. They live on local
disk when self-hosted and in S3 or R2 when hosted. Hosted buckets, databases
and their provisioning live only in `clankie-ops`, so a managed user sets up
nothing. Metadata lives in Postgres, or SQLite for single-machine self-hosting,
and never in the bucket. Bucket credentials come from the credential broker and
never leave the service.

**Records.** Each upload creates a record: file name, sha256, size, content
type, issue key, commit, actor (operator, worker or seat, with its on-behalf-of
chain), caption, and created-at. Many records may share one blob. `commit` is
the HEAD the evidence was produced against; the commit that lands the manifest
is found from git.

**API.**

- **Upload** takes the hash, size, content type and record fields, plus a
  client idempotency key. It answers immediately with a receipt and, only when
  the blob is missing, a presigned upload URL. The service checks sha256 and
  size before it accepts a blob. The sender can look the receipt up at once and
  sees `applied`, `pending` or `refused`, so a timed-out upload is reconciled,
  never resent blind. This is requirement A2 (exactly-once writes) in miniature
  and the pattern for VUH-1898.
- **Fetch** resolves an object to a signed URL that expires within 15 minutes:
  presigned S3/R2 URLs, or service-signed routes on local disk.
- **List** returns records by issue key or by commit.

Callers authenticate with Clankie's own identities, the operator, worker and
seat credentials the service already issues. The store has no separate accounts,
and no link, manifest, log or comment carries a long-lived credential.

**Callers.** `clankie evidence push|fetch` and MCP tools (`evidence_push`,
`evidence_fetch`, `evidence_list`) through `clankie mcp`. Both resolve paths
from the working directory and need no per-repo configuration, so they work in
any repo.

- `clankie evidence push [path] [--issue KEY] [--caption TEXT]` hashes the
  in-scope files under `path` (default `.`), uploads only missing blobs, and
  writes or updates the folder's manifest. It prints what it added and changed,
  with their links. The pushed raw files then move into the `.local/` mirror
  described below. A second run uploads nothing, leaves the manifest
  byte-identical and says so. A listed file absent locally keeps its entry;
  removing one is an explicit manifest edit.
- `clankie evidence fetch [path]` downloads listed objects into
  `.local/evidence/<repo-relative folder>/<path>` and verifies each sha256
  before moving it into place. A local file whose hash differs is reported and
  left untouched. Anything it cannot fetch or verify is named with its reason,
  and the command exits non-zero.

**Manifest.** `evidence.json` sits beside the folder's `README.md`, so agents
grepping the repo still find every pointer:

```json
{
  "version": 1,
  "objects": [
    {
      "path": "evidence/iphone-report-share.png",
      "size": 865655,
      "sha256": "<64 lowercase hex>",
      "url": "clankie://evidence/sha256/<64 lowercase hex>"
    }
  ]
}
```

Entries are sorted by path, which is relative to the manifest and uses `/`
separators, so a change is a one-object diff. The rest of the metadata lives in
records, not in git. The format is JSON because the CLI, the `docs/testing`
viewer and the tracker already parse it without a dependency, and the repo
formatter keeps it stable. A nested folder uses its ancestor's manifest.

**Links.** One object is referenced as `clankie://evidence/sha256/<64 lowercase
hex>`, in the `clankie://` scheme the app already handles. It names content,
not a location, so it survives a backend move or bucket rename. The service
resolves it to a fresh signed URL for an authorized reader.

**Migration.** READMEs and conclusions stay in git. Raw files are fetched on
demand into the root `.local/`, which is already ignored. History is not
rewritten, because clankie is public and clones depend on it; pack sizes
therefore do not shrink. Two consumers read archive files today:
`apps/tui/test/claude-tool-catalog.test.ts` and `scripts/evals/lead.mjs`. Each
gets a trimmed fixture it owns before its folder migrates. Then each repository
moves its existing evidence in one commit: push the folders, untrack the moved
files, commit the manifests. Media in evidence roots (`docs/testing/**` here,
clankie-app's `artifacts/` and `docs/`) gets ignore rules. `.gitignore` cannot
match on size, so a cheap repository check in `check:landing` rejects any newly
added in-scope file under those roots.

## Alternatives

Git LFS still materializes every file in every worktree, binds each clone to
one LFS server and its quota, and has no issue or actor records. A
tracker-only attachment store would leave repo evidence in git. Keeping
everything in git is the cost above.

## Consequences

- Workers publish evidence by writing the folder's `README.md`, running
  `clankie evidence push <folder> --issue <key>` (or the MCP tool), and
  committing only the README and `evidence.json`. Tracker comments cite the
  printed `clankie://evidence` links. The `clankie` skill, the `linear-issues`
  media rules and the [testing records](../testing/README.md) guide change when
  the commands ship.
- Worktrees and agent search stop carrying raw captures. Readers fetch only the
  folders they open. `pnpm testing:view` must learn to read the `.local/` mirror.
- The built-in tracker's evidence bundles (requirement A8) are lists of record
  IDs and `clankie://evidence` links, queried by issue or commit. The tracker
  stores references, not bytes. Its own uploads and the Linear import use the
  same upload path.
- Manifests in this public repo expose paths, sizes and hashes. Captions live
  in private records. Store access follows Clankie's identities.
- A Rust service adds a second native toolchain to the service build, as Vox
  already does. Store growth is unbounded until a retention decision.
