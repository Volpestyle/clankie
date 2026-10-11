# Governed server observation recovery

Tracks: https://linear.app/vuhlp/issue/VUH-2097

Based on fetched main `84e6f9dee6a19116da2d68ed17c283e41ebe8d09`.

Darwin libproc cannot observe an unreaped exited child: an owned real fork
returned zero bytes / ESRCH for both BSDINFO and SHORTBSDINFO while `kill(pid, 0)`
succeeded. The lease identity observer correctly reports unknown. A read-only
`kern.proc.pid` query independently proves SZOMB, so the CPU supervisor skips
that exited member without changing lease identity or admission.

The previous fallback charged invented whole-machine CPU and stopped observable
siblings whenever any member failed observation. The supervisor now resumes its
own living runner's group on failure, retains its permit, warns about degraded
CPU enforcement and re-baselines the first successful sample. CPU enforcement
can be exceeded during genuine uncertainty; it no longer starves the server to
repay unknown or historical CPU. Successful samples also continue the owned
group when its budget allows progress, including a stopped launcher that must
reap its child. No process is killed for observation failure.

Focused checks (all through `clankie heavy`):

- Server integration file: 8/8 passed, including real registered runners,
  journal, HTTP listeners, three transform-like burners, a persistent unreaped
  grandchild, stopped-launcher reaping and normal interruption/exit cleanup.
- At a 0.5-core budget, the healthy tree measured 0.453 cores and the persistent
  zombie tree 0.454 cores, both over six seconds. The general identity API still
  rejects the zombie before and after the measurement.
- The same new zombie regression fails against unchanged main's supervisor:
  0.131 cores fails its required progress floor of 0.2 cores. Original source was
  restored after this negative control.
- `@clankie/fleet-resources` typecheck and focused formatting passed.

The first focused run exposed a stopped-launcher resume regression; it was
corrected before the passing run above. Wynn's replacement Metro was inspected
read-only: all four current group identities passed 227 samples over 25 seconds.
His earlier stopped transform worker had already exited, so its precise failing
member was not captured. The real zombie reproduction proves the same native
error and old throttling mechanism, not that every live Metro warning is a zombie.
Wynn's process, device, wrapper and worktree were never modified.

Raw captures are listed in `evidence.json`. Integrate's exact-tree landing gate
is authoritative; no duplicate local root gate was run. Alert deduplication is
tracked separately as VUH-2098. Expo's manual `--max-workers 2` workaround remains
necessary where its own worker setting ignores inherited tool limits.
