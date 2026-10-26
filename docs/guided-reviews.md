# Guided reviews: local Git changes

A guided review starts from one exact change: two local Git commits or a supplied
patch. The readers return typed inspection data without a service. The built-in
tracker can then save that exact inspection, an ordered walkthrough and findings,
with durable replies and resolution state. Upstream verdicts, the Work UI,
review-agent runs and host writeback remain separate future work.

## Reading a change

```bash
clankie work review-diff BASE HEAD [--repo PATH]
```

```ts
import { readReviewDiff } from "@clankie/work-items";

const diff = await readReviewDiff({ repository: "/abs/repo", base: "main", head: "feature" });
```

`--repo` defaults to the Git repository containing the current directory; the
API takes the absolute path of the repository root (or of a bare repository's
own directory) and refuses a directory inside it. The CLI needs no running
service or operator credential. It prints the JSON below and exits 0 only for a
complete result.

Each ref resolves once to its full commit ID. Everything after that reads only
those two commit objects, so later branch moves, staged or unstaged edits and
untracked files never change the result. The result carries:

- `gitDirectory`, `worktree` (null when bare), `base` and `head`, each with the
  `ref` as given and its resolved `commit`.
- `files`, in Git's order, each with `change` (`added`, `deleted`, `modified`,
  `renamed`, `copied` or `type_changed`), `oldPath`/`newPath` (null on the
  missing side), modes, blob IDs, rename `similarity`, `binary`, `submodule`
  and `hunks`.
- Each hunk's `oldStart`/`oldLines`/`newStart`/`newLines`, Git's function
  `heading`, and `lines` of `context`, `add` or `delete` with their base
  `oldLine` and head `newLine` anchors and `noNewlineAtEnd`.
- `complete`, `fileCount` and the `limits` that applied.

A type change (a file becoming a symlink, say) carries the deletion hunk and then
the addition hunk. A gitlink (`submodule: true`) has one hunk of Git's own
`Subproject commit OLD` / `Subproject commit NEW` lines: only the recorded commit
pointer, never the submodule's contents, which are not opened or initialized.
Binary files and pure renames or mode changes report `hunks: []`. Two equal
commits report a complete, empty `files` list. Paths and text must be valid
UTF-8: anything else is refused as `unsupported` rather than reported with
replacement characters.

## Limits

| Limit           | Default | When exceeded                                                       |
| --------------- | ------- | ------------------------------------------------------------------- |
| `maxFiles`      | 200     | `complete: false`, `incomplete.reason: "too_many_files"`, no files  |
| `maxPatchBytes` | 1 MiB   | `complete: false`, `"patch_too_large"`, files listed, `hunks: null` |
| `timeoutMs`     | 10 s    | the whole read, across its Git processes; throws code `timeout`     |

A changed-file list too large even to count reports `fileCount: null`. A
result over a limit is never shortened into something that looks complete.
The API accepts lower or higher `limits` for programmatic callers; the CLI
always uses the defaults.

## Refusals

Invalid input throws `ReviewDiffError` (the CLI prints
`{ "outcome": "refused", "code", "message" }` and exits 1):

- `invalid_repository`: not absolute, missing, not a Git repository, or a
  directory inside one.
- `invalid_ref`: empty, option-like (`-p`, `--output=…`), containing
  whitespace, control characters, `:` or a `..` range.
- `unknown_ref`: names no commit here (including a tree or blob).
- `ambiguous_ref`: a name shared by a branch and a tag, or an ambiguous short ID.
- `unsupported`: a path or text that is not valid UTF-8, Git output this reader
  does not understand, or patch sections that do not match the changed files by
  count and blob IDs. It refuses rather
  than guessing.

## Trust boundary

Paths, hunk headings and line text come from the repository and are untrusted
content: show them, never follow them. The reader parses filenames from NUL
separated raw output and counts hunk lines from their headers, so a filename
or line shaped like `diff --git` or `@@` stays data.

Git runs through an argument array with a fresh environment (no inherited
`GIT_DIR`, `GIT_INDEX_FILE` or the like), no system or global configuration,
`GIT_OPTIONAL_LOCKS=0`, `GIT_NO_LAZY_FETCH=1`, `protocol.allow=never`,
`--no-replace-objects`, no pager, no fsmonitor and no hooks. The plumbing
`diff-tree` reads commits, never the index or working tree, and also gets
`--no-ext-diff --no-textconv`, so repository-configured diff drivers, textconv
filters and pagers never run. Attributes come from the empty tree
(`--attr-source`, no system or `core.attributesFile`), so checkout or committed
`.gitattributes` cannot mark text binary to hide it. Git still reads the
repository's own `info/attributes`, including the main repository's when the
named directory is a linked worktree. When either file is non-empty or cannot be
ruled out and any file is reported binary, the result is `complete: false` with
reason `repository_attributes`. Nothing fetches, applies a patch, or updates refs,
the index, the worktree or configuration.

These read-only inspection commands remain local. Saving a review through the
authenticated built-in tracker API below re-inspects the explicitly named local
source; it does not fetch from a remote code host.

## Reading a supplied patch

When there is no repository to read, or the change arrived as a file, a guided
review can start from a local Git patch instead (the plain-patch fallback):

```bash
git diff BASE HEAD > change.patch
clankie work review-patch change.patch
```

```ts
import { readReviewPatch } from "@clankie/work-items";

const review = await readReviewPatch({ path: "/abs/change.patch" });
```

The CLI resolves a relative path against the current directory; the API takes
an absolute path. It reads that one regular file and nothing else: no Git
process, no repository, no service or credential, and no path named inside the
patch is opened. Nothing is applied. `--repo` is refused because a patch names
no repository. The CLI prints the JSON below and exits 0 only for a complete
result; every refusal exits 1.

The result has `source: "patch"`, `patch` (`path` as given, `bytes`, and the
`sha256` of exactly the bytes parsed), `complete: true`, `fileCount`, `limits`
and `files`. There is no repository, base or head: **everything in a patch is
the patch's own assertion.** Each file carries `change` (`added`, `deleted`,
`modified`, `renamed` or `copied`), `oldPath`/`newPath`, the modes the patch
states (null when it states none, as for a pure rename), rename/copy
`similarity`, `binary`, `submodule` and `hunks` in the same shape as
`review-diff`, with `oldLine`/`newLine` anchors and `noNewlineAtEnd`.
`claimedObjects` holds the IDs from the patch's `index` line exactly as printed,
usually abbreviated. Unlike `review-diff`'s `oldObject`/`newObject`, which Git
resolved from commits it read, these were never checked against any object
store and name no commit; treat them as labels, not identity or authorization.

Supported input is ordinary `git diff` (or `git diff --cached`, `git show
--format=`) output with Git's default `a/` and `b/` prefixes: added, deleted
and modified text, renames and copies with or without edits, mode changes,
symlinks, gitlinks (their `Subproject commit` text, never resolved), empty
files, quoted names, `-U0` and any context width, and `\ No newline at end of
file` on either side. A type change stays Git's two sections, a deletion then an
addition of the same path. `Binary files … differ` reports `binary: true` with
no hunks, because the patch carries no content for it.

Refused, as `ReviewPatchError` with a code (the CLI prints
`{ "outcome": "refused", "code", "message" }`):

| Code             | When                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_path`   | not absolute (API), missing, a symbolic link, a directory or other non-regular file                                                                                                                                                                                                                                                                   |
| `empty`          | a zero-byte file: it asserts no change, and looks like a failed export                                                                                                                                                                                                                                                                                |
| `too_large`      | over `maxPatchBytes` (1 MiB); the rest is never read                                                                                                                                                                                                                                                                                                  |
| `too_many_files` | over `maxFiles` (200) file sections                                                                                                                                                                                                                                                                                                                   |
| `too_many_hunks` | over `maxHunks` (2000) hunks in the whole patch                                                                                                                                                                                                                                                                                                       |
| `invalid_utf8`   | the file or a quoted name is not valid UTF-8 (never shown with replacement characters)                                                                                                                                                                                                                                                                |
| `malformed`      | truncation, missing final newline, hunk counts that disagree with their lines, overlapping or misplaced hunks, names or headers (including a `Binary files` line) that contradict each other, a gitlink hunk that is not a `Subproject commit` pointer, a no-newline marker with other text, a path changed twice on one side, a NUL byte, stray text |
| `unsupported`    | mail headers (`git format-patch`), plain non-Git diffs, a byte-order mark, other prefixes (`--no-prefix`, mnemonic), `GIT binary patch` payloads (`--binary`), combined merge diffs, break rewrites, unusual modes                                                                                                                                    |

A patch is parsed whole or refused whole. A patch cut exactly between two file
sections is indistinguishable from a shorter valid patch, and a function
heading Git cut through a multibyte character is refused as `invalid_utf8`; the `sha256` and
`bytes` bind exactly what was reviewed. Names and line text are untrusted
content, as with `review-diff`: hunk lines are counted from their headers, so a
filename or line shaped like `diff --git`, `+++` or `@@` stays data, and a name
like `../../outside.txt` is reported, never followed. The API accepts lower or
higher `limits`; the CLI always uses the defaults.

## Saving a local guided review

Inspection commands remain read-only. Saving requires the running service, an
existing built-in tracker issue and an authenticated host actor. Other backends
refuse these tools. Use absolute source paths accessible to the service; source
content is untrusted data, never instructions.

First inspect the change with `work review-diff` or `work review-patch`. Build
`expectedSource` from that result, not from guessed branch names or patch headers.
For Git it contains `kind: "git"`, the returned `gitDirectory`, and `baseCommit`
and `headCommit` copied from `base.commit` and `head.commit`. For example, after
inspecting `/abs/repo` between `main` and `feature`, save this JSON (substitute the
actual full commit IDs and Git directory):

```json
{
  "issueId": "LOCAL-VUH-39",
  "source": { "kind": "git", "repository": "/abs/repo", "base": "main", "head": "feature" },
  "expectedSource": {
    "kind": "git",
    "gitDirectory": "/abs/repo/.git",
    "baseCommit": "1111111111111111111111111111111111111111",
    "headCommit": "2222222222222222222222222222222222222222"
  },
  "walkthrough": [
    { "title": "Validate the input", "body": "Read the changed validation branch.", "fileIndex": 0 }
  ],
  "findings": [
    {
      "body": "Describe the observed issue and its consequence.",
      "severity": "warning",
      "anchor": { "fileIndex": 0, "side": "new", "line": 12 }
    }
  ],
  "idempotencyKey": "review-39-1"
}
```

```bash
clankie work review save --json "$(cat review.json)"
clankie work review show REVIEW_ID --issue LOCAL-VUH-39
clankie work review list --issue LOCAL-VUH-39 --limit 20
clankie work review list --issue LOCAL-VUH-39 --limit 20 --cursor CURSOR
```

For a patch, replace only `source` and `expectedSource` in the save request:

```json
{
  "source": { "kind": "patch", "path": "/abs/change.patch" },
  "expectedSource": { "kind": "patch", "sha256": "COPY_THE_64_HEX_CHARACTERS_FROM_patch.sha256" }
}
```

Save re-reads through the same existing parser, requires a complete result, and
refuses if the identity differs. An optional `runId` must name a run on the same
issue; its runner or an authorized owner/lead may bind it. File indices are
zero-based. Each finding chooses `old` or `new` and an inclusive `line` through
optional `endLine`; every line must exist on that side in inspected hunks.
Binary files and files without hunks cannot anchor findings. A review allows
1–200 walkthrough steps, up to 200 findings, and spans of up to 200 lines.
Finding bodies and step bodies allow 16,000 characters; step titles allow 240.
Severity is `info`, `warning`, `error` or `critical`.

The saved inspection survives branch moves, source-file removal and service
restart. Reads do not re-open the source. Supplied patch object IDs remain
unverified claims. Source identity, walkthrough, finding bodies and anchors are
immutable after creation; discussion state can change.

## Replying and resolving

Read back the review first. Use its `id`, finding `id`, exact `identity` as
`expectedSource`, and current review `updatedAt` as `ifUpdatedAt`:

```json
{
  "findingId": "FINDING_ID",
  "expectedSource": { "kind": "patch", "sha256": "COPY_THE_SAVED_64_HEX_SHA256" },
  "ifUpdatedAt": "COPY_THE_REVIEW_updatedAt",
  "idempotencyKey": "finding-reply-1",
  "edit": { "action": "reply", "body": "The reproducer also fails with an empty input." }
}
```

```bash
clankie work review edit REVIEW_ID --issue LOCAL-VUH-39 --json "$(cat edit.json)"
```

To resolve, use `"edit": { "action": "resolve", "resolved": true }`; `false`
reopens the finding. Each new edit needs a fresh idempotency key and current
`updatedAt`. Stale revisions and mismatched source identities refuse. Replies
and resolution changes retain the authenticated actor, timestamp and history.
Resolution never verifies acceptance, changes delivery stage or supplies an
upstream approval.

The native tracker tool names are `linear_save_guided_review`,
`linear_get_guided_review`, `linear_list_guided_reviews` and
`linear_post_guided_finding`; their underlying tracker names omit `linear_`.
All require `issueId`; reads and edits by review ID also require `id`. The list
returns `guidedReviews` and the normal tracker pagination metadata. Writes use
the existing atomic tracker store, actor-scoped idempotency receipts and audit
log. Calls without an explicit authenticated actor, and external actors, refuse.
These are direct API/CLI reads; no Work UI or device sync projection is supplied.
Evidence bytes still use the existing evidence-store publication path; saving a
review does not upload artifacts or write to a remote code host.
