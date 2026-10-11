# Server holder alerts and CPU enforcement status

Tracks: https://linear.app/vuhlp/issue/VUH-2098
CPU follow-up: https://linear.app/vuhlp/issue/VUH-2097

The server holder remains visible immediately in resource status, but its lead
notification waits for the shared 15-minute threshold. A private exclusive claim
precedes delivery and persists across concurrent roster/refresh calls and service
restarts. A definite rejected delivery retries; uncertain delivery retains its
claim. At most once can miss a notification if the service dies after claiming
and before delivery. Claims identify one lease lifetime, independent of reason.

Unknown CPU observations expose `cpuLimitUnenforcedSinceMs` only when the status
sidecar matches the registered runner's PID and birth. This is snapshot metadata,
with no admission, arbitration or signal authority. Doctor displays "CPU limit
not enforced" and marks it WARNING after one minute. The supervisor emits a
warning after one minute and then every five minutes. Its normal interruption,
shutdown and failure paths continue its own living runner's group; status clears
on recovery or exit. The server permit stays held until ordinary ownership and
cleanup proof allows release. The shipped Mac admission policy is unchanged.

Focused governed verification:

- CLI/doctor/routes/server integration: 41/41 passed. App and TUI typechecks passed.
- Real HTTP notifications: a fresh holder sends zero; an aged holder retries one
  definite rejection, then delivers once despite four concurrent roster reads.
  A new runtime and governor over the same registry send no repeat.
- The same alert regression fails against main's original runtime: one fresh
  notification where zero is required. No production assertions were weakened.
- Real sidecar -> snapshot -> validated HTTP/CLI -> doctor: a stale birth is
  ignored; a matching birth exposes degradation and its minute warning; removing
  the sidecar clears the field. The assigned server permit remains held.
- The persistent unreaped grandchild sustains 0.424 CPU cores at a 0.5-core budget
  with three real burners. The identity API still rejects its zombie, while the
  CPU supervisor never enters degraded mode and creates no degraded sidecar.
- A separate manual Darwin sandbox proof denies real native CPU observations
  in an owned registered helper, with no mocked dependency or live-server edits.
  It checks server progress, a retained permit, the actual minute warning, and
  independent ownership/empty-group cleanup. Its injected restriction also
  denies the helper's ps cleanup probe: the helper exits with an unavailable
  boundary and retains its lease until the unsandboxed governor proves emptiness.
  The command's separately captured exit code remains 7. Normal helpers preserve
  status 7 in the ordinary integration suite.

Two initial sandbox attempts wrongly expected the restricted helper itself to
prove cleanup; those failed results are retained. A corrected short proof tests
the independent governor cleanup, without changing the production contract.
The corrected minute proof passed 1/1 (67.38 seconds total, with 63 seconds of
continued server progress checked). It verified the actual minute warning and
independent cleanup; the result and checked script are in the raw bundle. This manual sandbox
work uses only owned temporary files, private journals and processes; no machine
configuration, other seat's server, simulator or PC job was changed.

Quill confirmed that the view-only model/project changes do not overlap his
sampled arbitration/progress work. Basil was told the narrow native runner and
CPU sidecar scope. Integration supplies the exact-tree landing gate; no duplicate
local root gate was run. The Windows runtime (VUH-2091) remains separate.

Raw logs, the manual proof script and checked sources are in `evidence.json`.
