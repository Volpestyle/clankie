// VUH-2460: these timing-sensitive native/process proofs remain in `pnpm test`
// and release checks. Landing excludes them; their bodies and deadlines stay intact.
export const releaseOnlyTests = [
  "apps/tui/test/runtime-retention.integration.test.ts", // Native removal, 60 s load timeouts.
  "apps/clankie/test/runtime-canary.integration.test.ts", // Real process/deadline cases.
  "apps/clankie/test/native-process-transport.integration.test.ts", // Native stdio waits.
  "apps/clankie/test/local-fleet-admission-cancellation.integration.test.ts", // Admission timing.
  "apps/clankie/test/integrate.integration.test.ts", // Nested installs/gates, >300 s observed.
  "apps/clankie/test/fleet-lead-round.integration.test.ts", // Periodic inspection timing.
];
