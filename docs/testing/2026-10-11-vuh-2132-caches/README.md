# VUH-2132: guarded worktree cache reclamation

Manual only: `clankie checkouts reclaim-caches --repository OWNER_CHECKOUT
[--path WORKTREE]`, the owner-authenticated checkout API and tidy's
`reclaim_tidy_worktree_caches` use the same implementation. No automatic timer
or production cleanup was run. Automatic deletion needs operational evidence
beyond these focused fixtures; the retention check uses checkout, index, cache
and install/tag filesystem timestamps, not a claim of continuous inactivity.
Default retention is six hours, and a complete native cwd/pane census must show
no current use. Unknown observations refuse.

The real Mac fixture creates an owner Git repository and linked agent tree,
installs an offline local package with pnpm, and builds a Rust library with
Cargo offline, producing its real CACHEDIR.TAG outputs. An earlier Cargo build
failed because the test's isolated HOME lacked toolchain configuration; the
final run explicitly uses the already-installed Rust toolchain and a private
Cargo home. No toolchain install occurred.
The fixture reads the existing native Herdr socket without creating panes; it
skips hosts without that native dependency. No filesystem/process/Git mocks.

It proves recent retention, real live-child cwd exclusion, tracked and untracked
source edit preservation, authenticated HTTP/CLI deletion, rejection of a public
retention override, unchanged unlanded HEAD/source commit, retained `.local`
evidence, untagged-target exclusion, and preservation of a real nested Git
commit inside a tagged cache. The fixture's private retention override is zero;
the public API cannot change it. Oversized/deep cache inventories refuse rather
than skip nested repositories. Commits and worktree registration remain intact.

Focused consumers: tidy-worktrees, pane-tidy and TUI owner commands: 49 tests
passed before the nested-repository safeguard; the final extended real fixture
passes separately. Host-spec admission after the disk rebase: four tests pass.
Clankie source and all twelve test typecheck shards passed; the final cache/API/
CLI roots also receive a focused typecheck after the cache safeguard changes.
Formatter ran on all touched files. The exact-tree landing gate belongs to the
integrator and must pass before reporting this slice landed.
