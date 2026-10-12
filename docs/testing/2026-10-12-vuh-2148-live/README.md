# VUH-2148: live gate priority after deployment

The lead deployed `37e8a04bf` at 09:50:38Z on 2026-10-12. The public update status confirms runtime instance `66c8d7ca-505b-4fa0-9525-93993023a22a`. The next real batch, `9fe27ecc-8de6-4f9f-82bd-18774293f109`, submitted VUH-2160's launcher-path fix at 09:56:40Z against that exact deployed base. No synthetic batch or full-suite loop was needed.

| Recorded phase       | Seconds | Result                                    |
| -------------------- | ------: | ----------------------------------------- |
| Install              |  11.870 | Exit 0                                    |
| Gate receipt         | 446.746 | Exit 0                                    |
| Root gate summary    |  445.99 | Exit 0                                    |
| Vitest wall time     |   95.06 | 707 passed, 15 skipped                    |
| Vitest summed import |   84.39 | 99 selected modules; 91 passed, 8 skipped |

The pushed composed head is `330d6fb87333ebca00ef8a8b4a5f1a44ec6c4a72`; its push receipt confirms exit 0. This selection differs from the historical 363-module gate, so these times are not a controlled before/after comparison. The [same-selection import measurements](../2026-10-11-vuh-2148-imports/README.md) retain their separate instrumentation and changing-load limitations.

## Live admission proof

The service-owned full permit `a74a75d6-c984-4f31-9f4b-eddd453b6ed4`, holder `integration:9fe27ecc-8de6-4f9f-82bd-18774293f109`, was created at 09:56:43.785Z before installation began at 09:56:44.493Z. Seven public resource snapshots retain that same permit during the gate.

Two owned, cheap commands used the normal CLI: a full-lane Node admission marker, and a light-lane formatting check of ADR0266. Both queued behind the merge gate with three full slots and four light slots free and healthy available memory. Another ordinary worker's full build also queued. The marker was absent while queued; it ran at 10:04:24.282Z, 1.173s after the gate finished. Its wait was 436.931s. Both probes completed exit 0, and the final resource snapshot shows their tickets removed.

Measured machine CPU during the gate was 20.6–58.2%, and load was 0.35–0.63 per core against a 1.5 policy. This was concurrent simulator/server activity, not an above-limit overload. Earlier full builds had finished before gate admission; the initial status shorthand mistakenly counted the simulator as a full job, and the corrected analysis filters `kind == heavy`. The raw snapshots preserve the facts.

The existing simulator and server holders continued. A supplementary read-only simulator plan using the pane ID was refused `owner_unavailable` after gate completion. No simulator acquire, ticket or boot ran. Simulator priority is covered by the earlier [real native priority proof](../2026-10-11-vuh-2148-gate-priority/README.md), including reservations and boot submission under controlled admission inputs on a Mac at 2.48 load/core. This live capture does not claim a new simulator boot or an authenticated simulator-acquire proof.

[Evidence archive](clankie://evidence/sha256/808ee32692528bfc10874baa78a45ce411c5f726a2040d8c1fe856df95d42564) contains runtime identity, raw resource/batch snapshots, probe queue tickets and logs, exact source selection, gate and push receipts, and the read-only simulator refusal. The capture/analyzer scripts and initial shorthand are retained. No assertion, timeout, isolation or resource guard changed for this measurement.
