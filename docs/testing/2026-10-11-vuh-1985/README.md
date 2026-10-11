# VUH-1985 — Claude tracker identity and owner wakes

Tracks: https://linear.app/vuhlp/issue/VUH-1985

Worker and operator plugins deny inherited Linear MCP tools locally and display
posting guidance at startup. The guard requires neither a pane nor the bridge.
Plain Claude without these plugins keeps personal connector access; no personal
profile is edited. Worker version 0.6.17 and operator version 0.3.6 make new bytes
available through normal plugin updates. Existing sessions require native reload
or deliberate resume after updating; no running lane was steered here.

Owner/human wakes require an explicit signed user actor. App/integration or
unknown actor types and host-recorded workers do not qualify as owner activity.
User-authenticated external connectors can produce indistinguishable user events;
actor IDs cannot prove a person authored them. Plugin connector denial prevents
that path in Clankie sessions. The owner retains plain Claude use.

Verification on fetched main `cdd373cab41ca375c2bccea59cff1322ba8c6200`:

- Seven focused files: 46 tests passed, one manual native proof skipped, 39.95s.
- Native proof: private Claude profile installs actual worker plugin, then its
  installed hook denies `linear-server` under bypass-permission input. One test
  passed, 1.22s (capture rerun 3.14s). No model turn or provider write. This proves
  native packaging and hook output, not the interactive permission engine.
- Signed HTTP integration uses Linear's published user-actor Comment envelope,
  signed with a fixture secret and current fixture workspace/time. It preserves
  owner-chat wake and excludes unknown/app/integration origin fixtures. This is
  a public-schema fixture, not a retained real James event or live-provider proof.
- Native delivery regression proves signed owner activity reaches its bound
  operator outbox without model fallback.
- Service typecheck exit 0; direct formatter on all 15 touched files exit 0.
- Retained failures: initial test startup before install; quoting fixture missing
  user actor type. Corrected without weakening quoted-context assertions.

Integration gate and push are pending; no local duplicate root gate was run.
