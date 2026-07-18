# VUH-797 implementer result

status: blocked

summary:

- Added `priority` beside tracker-owned intent and acceptance criteria in the doctrine bindings documentation and every base profile, using the same source binding as `product_intent`.
- Added `priority` to the tracker authority-role gate. Existing mirror code already imports priority into immutable mission contracts and detects priority drift, so no mirror implementation or outbound mutation code changed.
- Added focused compiled-profile and priority-only import/drift tests. The existing all-preset invariant-floor tests for `tracker.priority.update` remain unchanged and pass in the focused doctrine suite.
- Full repository tests are blocked by an out-of-scope control-plane fixture: `apps/control-plane/test/tracker-mirror.test.ts` overrides the self-build profile's tracker bindings for `product_intent` and `acceptance_criteria`, but not the newly required `priority` binding. The import endpoint therefore returns 409 instead of 201.

files_changed:

- `docs/04-doctrine.md`
- `doctrine/profiles/fine-control.yaml`
- `doctrine/profiles/rawdog.yaml`
- `doctrine/profiles/self-build-lab.yaml`
- `doctrine/profiles/structured.yaml`
- `packages/doctrine/test/doctrine.test.ts`
- `packages/tracker-connector/src/types.ts`
- `packages/tracker-connector/test/tracker-connector.test.ts`
- `.wave/result.md`

commands_run:

- `pnpm --filter @clankie/doctrine test && pnpm --filter @clankie/tracker-connector test` — exit 0 before changes; doctrine 31 passed, tracker connector 61 passed and 2 live tests skipped.
- `pnpm --filter @clankie/doctrine test && pnpm --filter @clankie/tracker-connector test` — exit 0 after changes; doctrine 32 passed, tracker connector 62 passed and 2 live tests skipped.
- `pnpm fmt:check` — exit 0.
- `pnpm lint` — exit 0.
- `pnpm docs:check` — exit 0; 138 Markdown files checked.
- `pnpm typecheck` — exit 0; 40 workspace tasks passed.
- `pnpm test` — exit 1; the control-plane tracker import integration test expected HTTP 201 and received 409 after the authority gate began requiring `priority`.
- `pnpm vitest run apps/control-plane/test/tracker-mirror.test.ts --reporter=verbose` — exit 1; reproduced the single failing assertion at line 102 (`expected 409 to be 201`).
- `pnpm arch:check` — exit 0; 40 workspaces passed.
- `git diff --check` — exit 0.

remaining_risks:

- The branch is not CI-green until the Linear-bound doctrine helper in `apps/control-plane/test/tracker-mirror.test.ts` adds `priority: { kind: "connector", connector: "linear" }` beside its other tracker authority bindings. `apps/**` is explicitly outside this worker's hard write scope.
- Independent verification has not occurred; this is an implementer receipt only.

assumptions:

- `OrchestrationProfileSchema.authority` intentionally remains an open role-to-binding record; the first-class role is established by the compiled base-profile bindings and the tracker connector's field-authority role list rather than by introducing a new closed enum.
- The unchanged doctrine tests that require approval for every tracker authority mutation under all three public presets, plus the unchanged test that prevents an `allow` override for `tracker.priority.update`, satisfy the ruling's outbound-floor proof requirement.
- Priority import and drift comparison in `packages/tracker-connector/src/mirror.ts` are already correct, so the requested additive focused test is preferable to changing that implementation.

blocker:

- Smallest lead action: authorize a separate in-scope fixture correction, or expand this task's write scope to the single authority object in `apps/control-plane/test/tracker-mirror.test.ts`, then rerun `pnpm test` and the complete gate set.
