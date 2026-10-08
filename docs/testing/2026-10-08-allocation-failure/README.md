# Actual allocation refusal

The x86_64 slice of the unchanged production proof implementation emitted:

```json
{
  "schemaVersion": 1,
  "stage": "fd_list",
  "reason": "allocation_failed",
  "errno": 12,
  "attempt": 1,
  "retry": false
}
```

The owned fixture enters the production proof on an actual loopback TCP pair.
Its unconstrained baseline returns a valid proof; the constrained child returns
exit 1 with no proof. No allocator, syscall, socket fact or diagnostic is replaced.
The original stock allocator fails after bounded, untouched `PROT_NONE` virtual
address-space reservations. At most 1024 reservations and 32 MiB of retained
buffers are allowed, with a five-second alarm and seven-second parent timeout.
Child exit releases everything. The successful exploratory run used 74
reservations and retained zero FD buffers. The ARM variants returned valid
proofs and are failed candidates, not producer evidence.

The use of tagged virtual ranges follows the original Apple
[VM map implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_map.c)
and [stock allocator VM API](https://github.com/apple-oss-distributions/libmalloc/blob/main/src/vm.c).
The test requires x86_64 execution (already available here); it neither installs
Rosetta nor pressures host RAM. Existing `project-hires.ts` is untouched.

Reproduce only manually, inside the fleet governor:

```sh
clankie heavy -- env FLEET_ALLOCATION_TEST=1 pnpm exec vitest run apps/clankie/test/fleet-allocation-native.integration.test.ts
```

The integration asserts the actual diagnostic through the production schema,
collector and five/sixty-minute windows. Native diagnostics remain distinct
from terminal proof attempts; the denominator stays zero in this direct helper
producer test. It does not claim a deployed check or an ARM producer.

Verification: the focused native integration passed 1/1; `pnpm check:landing`
passed formatting, lint, deadcode, doc links and all 29 typechecks. The landing
gate intentionally skipped the one manual-only test; the preceding opt-in run
executed it. Both ran through `clankie heavy`. The [redacted actual capture](capture.json)
retains the refusal and counter evidence. Raw local evidence is under
`.local/allocation-os/`.
