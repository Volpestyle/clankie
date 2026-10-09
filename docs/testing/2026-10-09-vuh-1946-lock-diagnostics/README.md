# VUH-1946: live lock-helper EBADF remains unproven

The two retained live admissions at about 08:06Z and 09:09Z failed with
`Fleet resource lock helper failed: OSError (errno 9)`. Both predate VUH-1938's
operation diagnostics and neither identifies the failing syscall. The second
capture records `childStarted: false`.

At the 2026-10-09 14:32Z investigation boundary, no new stage-labelled EBADF
was found in the current service log, retained worktree `.local` log/JSON/JSONL
captures, today's Codex records or Claude project records. Only the original two
retained worker captures matched the exact lock-helper error. This search does
not establish that no unretained admission failed.

The installed helper and main's `native.py` have identical SHA-256
`dfe386cd98b537915a834646f13e1b392834f57f4f22757317bdce12f6698951`.
Each lock transaction launches that helper anew. VUH-1938 therefore supplies the
operation diagnostic for subsequent helper failures; it is not an EBADF fix.

## Native observations

Two existing real native checks passed on `4ecb3364b4465feb920b227b5d6c22eb0d485dc1`
through `clankie heavy` (35.10 seconds; 15 unrelated cases skipped):

- Eleven queued requests retained their exact tickets during a 17-second
  kernel advisory-lock hold, then all eleven exited zero, produced command
  receipts and emptied the private queue. No EBADF occurred.
- Native filesystem and journal-decoding failures reached the public bounded
  diagnostic contract as `FileExistsError (errno 17) at directory-create` and
  `JSONDecodeError at journal-read`, without leaking paths or journal contents.

The contention check uses a private fixture registry and real native helpers;
it does not change the shared machine's policy or lanes. Passing contention
does not prove the intermittent failure was fixed, nor establish the historical
failed ticket's lifetime or all possible duplicate-start paths.

## Descriptor trace and remaining gap

The lock subprocess owns its input/output streams and its advisory-lock file.
The context holds that lock through the reply. Journal writes transfer the
temporary descriptor to `os.fdopen`, close it through the file context, then
open, sync and close the directory descriptor. `ResourceStore` settles the
helper's drained completion after submitting the journal write. Inspection did
not establish a closed/reused descriptor at any of these operations.

The actual EBADF syscall and descriptor lifetime remain unknown. No retry,
capacity, deadline, durability, fd-handling or admission change is justified by
these observations. No product fix is claimed or shipped by this record.

The next live failure must retain its bounded `at <operation>` diagnostic,
timestamp and original admission outcome. Keep that original receipt; a later
successful probe cannot settle the failed admission. Do not blindly retry EBADF
or discard a journal sync/replace/close error. VUH-1946 remains unresolved.

The evidence manifest links the redacted search summary, exact helper source
and native-check output. Private originals remain in the referenced worktrees;
this archive contains no lease tokens, process arguments or journal contents.
