# VUH-2949: tool activity stays out of speech

The service regression exercises live native events through the conversation store,
operator service and real loopback HTTP presence endpoint. Vitest setup creates a
scratch HOME and removes inherited Clankie and credential overrides.

On baseline `450b7f16d`, the updated regression failed with eight assertions:
Bash returned its tool name and JSON command instead of its description; tools
without descriptions exposed arguments instead of plain labels; Linear still
routed correctly but exposed the tool name and arguments. The failure output is
retained locally at `.local/vuh-2949/service-red.log`.

After the fix:

```text
clankie heavy -- pnpm exec vitest run apps/clankie/test/current-activity-http.integration.test.ts packages/protocol/test/presence-activities.test.ts
Test Files  2 passed (2)
Tests       3 passed (3)
```

The HTTP regression checks Bash descriptions, collapsed whitespace, hire titles,
plain fallbacks, typed Linear issue routing, call lifetime, unchanged chat,
complete pending owner questions, revocation and settled-event removal.

The separate app worktree is `/Users/james/dev/clankie-app-wt/vuh-2949-app`.
Its shared pet regression failed on baseline `339ee8ca4` (four tool cases popped
bubbles; 103 existing cases passed). With the filter, all 107 component tests
passed. The working pose remains and a subsequent chat still bubbles. This is
component evidence, not a native Mac or installed-build claim. Native verification,
service deployment and Mac shipping are recorded on the issue when available.
