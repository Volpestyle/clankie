# VUH-2167: fresh native history

A managed Codex 0.160.1 root is named before its first brief. Native
`thread/name/set` creates metadata while the rollout is still absent. Both
`thread/resume` and paginated history can then report `invalid paginated history
lineage ... missing source rollout`. The controller formerly recognized only
older no-rollout responses from resume and treated this fresh lifecycle as a
pre-dispatch failure.

Subscription and history hydration now have independent completion flags. The
exact missing-root response may remain pending before the first physical turn
RPC only when all of these hold: a complete empty-server inventory before view
startup; native creation time within that startup window; matching nonempty
path and thread identity; a non-ephemeral, non-forked idle root; one exact loaded
thread; and no observed turn or pending question. Unknown creation evidence or
host clock skew refuses deferral. Saved, forked, corrupt and mismatched history
remains refused. The dispatch latch is irreversible; after a turn RPC, history
must hydrate and any error remains uncertain rather than replaying input.

## Real native proof

`codex-fresh-history-native.integration.test.ts` exercises
`startCodexAppServerSeat` over real Unix WebSocket connections to installed
native binaries, with an independent native client creating the view's root.
No dependency is mocked. Each case has its own temporary home; native
`account/read` confirms no account. No owner credentials or provider responses
are substituted. An accepted native turn is persisted even when model execution
cannot authenticate; the proof does not claim a successful model answer.

The four cases prove:

- the named fresh root accepts exactly one brief, whose exact turn and user
  input are read back through real paginated history and the durable rollout;
- a saved identity with missing history cannot start;
- a real fork with its persisted ancestor removed cannot dispatch;
- corrupt native session metadata cannot bootstrap the controller.

Codex 0.160.1 (matching the failing PC version) and 0.162.1 each passed all four.
Version 0.162.1 materializes earlier, so its saved-history case breaks a genuine
persisted, unloaded saved root rather than assuming the older lazy lifecycle.
The 0.160.1 native binary SHA-256 was
`09fa44fdc37a5fc70dc1ace31235f90468a2e193d0e85f7552eab068ea2582be`.

Run manually with an explicit installed native binary:

```sh
clankie heavy -- env CODEX_HISTORY_NATIVE_TEST=1 CODEX_HISTORY_NATIVE_BINARY=/path/to/native/codex pnpm exec vitest run apps/clankie/test/codex-fresh-history-native.integration.test.ts
```

The native proof is opt-in, not a model eval. Existing controller, question,
protocol and remote-adapter checks also passed: 77 cases, one existing optional
skip. The service typecheck passed; the integrator supplies the final exact-tree
landing gate.

## PC boundary

Read-only diagnosis on the actual PC proved one loaded, idle, non-forked root;
a connected pinned worker catalog with all six tools; an expected metadata path
whose rollout was absent; and the exact native paginated-history error. No pane
was closed or steered, no resume/turn RPC was sent there, and no hire was retried.
A deployed PC first-brief proof remains with the KH2 lead after deployment.
VUH-2144's catalog/settlement acceptance is independently complete; its original
fresh intent retains authenticated abandonment. VUH-2153 tracks remote close.

## Remote naming follow-up

The deployed retry exposed a gap in this original fixture: it named roots
before the controller's first read. Codex 0.160.1 replaces synthesized read-time
creation metadata with actual creation metadata during naming. The controller
must establish its freshness baseline after the confirmed naming step.
[The remote follow-up](../2026-10-12-codex-remote-fresh-history/README.md)
records the real delayed-native regression, read-only PC diagnosis and fix.
