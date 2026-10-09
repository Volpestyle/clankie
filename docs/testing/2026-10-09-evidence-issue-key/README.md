# VUH-1951 / VUH-1954 item 2: evidence issue keys

Integration checks use real git repositories, a local HTTP evidence service,
SQLite and disk blobs. Three checks passed: branch → worktree directory → folder
README inference, explicit override and unkeyed fallback; secondary-key reads
through the CLI/recent filters and device `evidence_records`; records-only
backfill dry run/apply/repeat with unchanged blobs and upload receipts.
The clankie, tui and protocol typechecks passed.

The live SQLite store was opened read-only on 2026-10-09. Of 1,209 records,
311 were unkeyed and 431 contained multi-key strings. The proposed repair changes
1,057 records: 159 receive inferred keys (158 from folder READMEs, one from git
history), and 898 existing keyed records get separate key metadata, including
431 multi-key strings. Proposed unkeyed count: 152; all 152 were skipped because
they name another repository. Proposed multi-key string count: zero.

No live backfill was applied. The backfill is lead-approved conditionally: deploy a build
containing the new reader first, then copy the live database to a timestamped
backup beside it before applying. Use SQLite's online backup to include committed
WAL data in that copy. The next deploy is blocked behind VUH-1953; this assignment
lands code only and leaves VUH-1951 In Progress, **backfill pending deploy**.

After deployment and the timestamped backup, the approved command is:

```sh
clankie evidence backfill --database ~/.clankie/evidence/evidence.sqlite --repo ~/dev/clankie --apply
```

The retained proof includes every proposed record, its source and before/after
keys, plus the inspected focused-check and typecheck output. Raw proof lives in
the evidence store via `evidence.json`.

The proof push uses the new checkout CLI without `--issue`, from branch
`clankie2/vuh-1951-evidence-issue-key`; its output reports `VUH-1951` from `branch`.
Root landing-gate results are reported on the issue after the final checked
commit is pushed; these focused checks do not substitute for that gate.
