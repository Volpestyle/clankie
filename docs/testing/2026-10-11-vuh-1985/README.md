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

Correction and rebased verification:

- Original combined integration gate exited 1 because the runtime hook was not
  registered as an explicit knip entry. The failed gate is retained in correction
  evidence. No landing or successful full gate is claimed.
- Registered the runtime entry and closed a leading-underscore MCP tool-name
  bypass in the matcher. Corrective deadcode check and direct formatter exited 0.
- Rebased cleanly on `cf61cc10a9b0af7558b84d6b9bc40c8a7d137269`. All seven focused
  files passed: 47 tests including the private native install proof, 34.93s.
- Corrected code tip: `6f79608c7c2228bddab511216da72cc48e97482c`. The original
  request `357cd184-5425-481e-8688-6e2c147d7599` remains in isolation. Per the lead,
  preserve it until terminal, then submit the corrected tree.

Migration correction on `8ae28f675`:

- The second full gate exited 1 at the legacy migration's owner wake assertion.
  Reproduced exactly (one failure, 11 passes): its owner fixture omitted the
  published user actor type. Preserved the configured wake assertions, added
  the user actor type, and verified unknown origins remain rejected.
- Signed HTTP proof now covers both current and legacy persisted owner settings
  with the published Comment envelope. Eight focused files passed 60 tests
  (53 in the combined run and seven Linear-follow checks), including the private
  native plugin installation proof. Direct formatting passed.
- [Linear's current SDK actor contract](https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_documents.ts)
  requires a type string on every non-null actor variant. Both Comment and Issue
  webhooks use this common envelope. Nullable/deleted actors cannot prove an owner.
  This is provider-contract evidence, not a retained real James delivery.
- Old request `74fc8ebf-3cd3-430c-99c5-39b27099b8e3` was cancelled while queued in
  isolation, at the lead's direction. The corrected tree awaits a fresh request.
