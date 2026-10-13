# VUH-2216: runtime stalls

Read-only native profiling of service PID 98101 on commit `42070cda8` showed all four libuv filesystem workers spending about 17% of the 20-second sample unlinking files. This overlapped terminal batch isolation cleanup from 09:50:37 to 09:50:53Z. Ordinary Git worktree removal already runs in a child; recursive isolation and partial-removal fallback deletion ran in the service itself.

A 90-second paired health/roster window at load 9.8–15.7 reproduced health p95 **437.9 ms**, max **1,655.3 ms**; roster calls took **2.7–8 s**, with one timeout. It overlapped another 3.69 GB isolation cleanup. A later health-only control on commit `9de66a3e0` measured p95 **399.6 ms**, max **885.9 ms**, without this probe making roster requests. Native traces also show JSON parsing and filesystem completion work; deletion is a confirmed contributor, not established as the whole cause.

The change puts recursive integrator and manual cache deletion in an awaited child Node process. It keeps the caller's ownership, terminal-state, retry, dirty-tree, inventory and live-cwd checks, Node's removal semantics, symlink behavior and error propagation. No shell interprets directory names. No admission, timeout, canary policy or service lifecycle changes.

Governed checks: four existing real cleanup cases passed (83.52 s); expanded real historical-reclaim boundary case passed (42.31 s), preserving an external symlink target and handling literal metacharacters. The first added fixture attempt failed creating a missing parent; corrected before its passing rerun. Explicit touched-file formatting and lint passed. The integrator supplies the exact-tree root landing gate.

**Open acceptance:** JavaScript attribution of the remaining stalls, a full post-fix canary window on a busy machine, and roster calls under one second. The lead started supported CPU profiling on PID 92871 at 10:24Z; a bounded 20-minute public health/roster/load probe began at 10:26:06Z. No worker restart, inspector activation, or privileged trace was performed. The attempted read-only fs_usage trace could not run without a password. Deployment and issue closure belong to the lead.

Protected raw baseline/profile/check bundle: `clankie://evidence/sha256/aee7f4ab8e8343d9af7f188c2df28abaaee245621f7b38969d67e9bc2539108b`.
