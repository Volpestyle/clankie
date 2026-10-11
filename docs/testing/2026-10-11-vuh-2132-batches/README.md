# VUH-2132: terminal batch worktree retention

Tracks: https://linear.app/vuhlp/issue/VUH-2132

Real Git repositories, local bare remotes, installs, gates and process cwd on the Mac:

- Two terminal fixtures prove the one-hour retention boundary, removal after expiry, unchanged gate logs, retained records and detached commits, and successful restore from the retained clone after its checkout is removed.
- A real Node child with its cwd in a failed batch prevents removal. After it exits, an uncommitted source edit still prevents removal and retains its exact contents. Clearing that fixture edit permits removal.
- The authenticated `clankie integrate reclaim` CLI/API uses the same retention-respecting sweep.
- The existing integration and remote-gate consumer run passed 37 existing cases. Its first two new cases failed on an overly broad cwd census; the corrected cases passed separately. Initial failures are retained in the proof archive.

The service sweeps every five minutes, under the integration queue lock, up to 32 trees per sweep. Passed, held and partial batches stay available for later push. Terminal scratch trees stay when dirty, aliased, locked, live, or observation is incomplete. `record.json` records removals. Repository clones and logs remain; this does not delete source worktrees or reset Docker.

The process proof requires complete cwd observations for live processes running as this account and includes all other visible system cwd. Zombies have no live cwd; root-owned login helpers are outside the account census. Unknown observations skip reclamation. The new native reclamation fixtures are Mac-specific; no Windows cwd observer is claimed.

## Gaps

No production batch was reclaimed or service restarted during this proof. The lead must activate the landed runtime through its normal update path. Dirty scratch trees deliberately remain for inspection.
