# C1 deployment and rollback: lead-owned commands

C1 is on main `3a266cbdae11d6ef3a12b7ebf2477953c95d73fa`.
These commands are for Clankie to execute. The worker has not stopped, restarted,
signalled, deployed or converted the installed service/ledger.

## Before deployment: snapshot the current flat ledger

Run this before installing C1. The existing journal writer replaces the file
atomically; copying its opened inode gives a complete generation. A newer
receipt may arrive afterward, so this snapshot is a fallback/audit source, not
the normal rollback input.

```sh
umask 077
VUH2827_BACKUP="$HOME/.local/state/clankie/receipt-backups/vuh-2827-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$VUH2827_BACKUP"
cp -p "$HOME/.clankie/worker-grants/receipts/connected-calls.json" "$VUH2827_BACKUP/connected-calls.pre-c1.json"
shasum -a 256 "$VUH2827_BACKUP/connected-calls.pre-c1.json" > "$VUH2827_BACKUP/pre-c1.sha256"
printf '%s\n' "$VUH2827_BACKUP"
```

Keep the printed backup directory. Deploy C1 using the lead's normal runtime
procedure. This runbook does not call `update_runtime`.

## If the canary rolls back to a pre-C1 runtime

The old reader refuses the new manifest. Stop the service before conversion;
no C1 or old service writer may run during backup, conversion or installation.
Retain the original delivery IDs. Do not replay uncertain connected calls.

```sh
clankie stop clankie
clankie status
```

Confirm status reports the service stopped. In the same shell (or reassign
`VUH2827_BACKUP` to its printed literal path), snapshot the CURRENT ledger and
shards. This includes receipts written after migration:

```sh
mkdir "$VUH2827_BACKUP/at-rollback"
cp -p "$HOME/.clankie/worker-grants/receipts/connected-calls.json" "$VUH2827_BACKUP/at-rollback/connected-calls.json"
if test -d "$HOME/.clankie/worker-grants/receipts/connected-calls.json.d"; then
  cp -Rp "$HOME/.clankie/worker-grants/receipts/connected-calls.json.d" "$VUH2827_BACKUP/at-rollback/connected-calls.json.d"
fi
```

Run the tested converter on that stopped CURRENT ledger, not the pre-deploy
snapshot. It leaves shards intact and atomically replaces only the root with
a complete legacy array. It checks shard names, SHA-256 digests, identity/state,
duplicate IDs, and unchanged source/shard generations. It preserves all record
fields, all uncertain receipts and all tombstones; it applies no retention.

```sh
cd /Users/james/dev/clankie-wt/tmp-2817-FgB9
clankie heavy -- node .local/vuh-2817/rollback-connected-receipts.mjs \
  --source "$HOME/.clankie/worker-grants/receipts/connected-calls.json" \
  --output "$HOME/.clankie/worker-grants/receipts/connected-calls.json" \
  --replace --service-stopped
```

On success, retain the printed record/uncertain counts and hashes. Confirm the
active runtime is the intended rollback version, then:

```sh
clankie start clankie
clankie status
```

If conversion fails, leave the service stopped and preserve both snapshots and
shards. A missing/corrupt shard is a hard refusal, not permission to restore the
older pre-deploy file and discard newer receipts. A post-rename directory-sync
failure explicitly reports installation uncertainty; inspect the resulting root
before another conversion. Do not delete the shard directory during rollback.

## Proof

`rollback-proof.mjs` uses an offline copy of the actual 8,909,873-byte ledger.
Production C1 WorkerMcp with its complete WorkerCallReceiptSchema migrates
16,452 receipts (56 uncertain), then adds and saves a new uncertain receipt.
The exact reverse command above runs in place on the disposable copy.
An independent process loads the result using pre-C1 WorkerMcp and
DurableReceiptStore sources from commit `6e6909245`, including the original full
schema. It finds 16,453 receipts and 57 uncertain, including the post-migration
receipt. A canonical SHA-256 comparison covers every committed record field.
No provider is invoked and no live file is written. Negative checks reject a
missing/corrupt shard and unsafe overwrite without modifying the manifest.

Reproduce inside the worktree (private captured input stays local):

```sh
clankie heavy -- node --import ./scripts/dependency-types.mjs .local/vuh-2817/rollback-proof.mjs
```

Summary: `.local/vuh-2817/rollback-proof-summary.json`.
This runbook applies to connected-call C1 only. Conversation metadata C2 has a
separate migration and must receive its own rollback treatment before deployment.
