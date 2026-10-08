# Simulator device reuse

VUH-1829 fixes repeated costly first boots without booting a real simulator
during verification. Work starts in a fresh worktree at fetched main `0789ea00`.

Within the boot-history preference described below, selection prefers exact
idle type, then a close screen model, then an idle
iPhone or iPad of the same family on the requested runtime. Exact requests stay
exact. Unavailable devices, wrong runtimes, other families and active journal
claims remain excluded. Historical fleet names alone no longer exclude reuse.
Release, expiry and proven seat exit stop the leased device and retain it.
No automatic delete remains; a separate explicit owner tidy names stopped UDIDs.
Uncertain create receipts still hold their name and capacity; names never prove
ownership or authorize deletion.

Owner API `action: plan` is read-only creation/reuse advice. The CLI checks it
before each acquire, announces creation's expensive first boot and the idle
timeout, and supports `fleet simulator` as an alias. The plan reserves nothing;
actual admission and native effects recheck inventory and authority. No change
is made to ongoing lanes or their leases.

The existing subprocess simctl adapter boundary runs an owned file-backed
fixture instead of Apple's simctl. Added integration cases prove both family
fallbacks; two new leases across manager restart boot the same retained created
UDID with one create and zero deletes; uncertain-name exclusion; read-only
planning; and a CLI warning recorded before any create/boot effect. Existing
authority, shutdown-uncertainty, disconnect and capacity checks remain in scope.
Only a read-only host inventory was inspected to identify the native `lastUsedAt`
signal. No real simulator boot, shutdown or deletion was requested.

Focused checks and `pnpm check:landing` run through `clankie heavy`; results and
landed commit are attached to VUH-1829. No simulator/native performance claim
is inferred from the adapter test.

Within the requested family and runtime, a valid native `lastUsedAt` timestamp
puts previously booted devices ahead of devices with unknown boot history,
even when the latter match the requested model exactly. Among those candidates,
exact model then close model then family determines preference. `exact: true`
never substitutes a different model; an explicit `deviceId` remains strict.
Missing or malformed metadata is unknown, never proof of a previous boot.

The refinement follows the 04:55Z issue sample: leasing an existing but
never-booted iPhone 17 Pro still drove reported load to 168 on eighteen cores.
The read-only native inventory showed `lastUsedAt` on previously used devices
and its absence on stock devices with approximately 18 MiB data containers;
selection uses the timestamp, avoiding filesystem walks or size thresholds.
This is a preference signal, never a grant of ownership or a performance
measurement. Added iPhone/iPad HTTP cases prefer a warm family substitute over
a cold exact model, preserve explicit exact/UDID requests, and ignore malformed
metadata. A separate case prefers a warm exact device over a cold exact device.

Focused verification passed: three integration files, 48/48 tests, through
`clankie heavy -- pnpm exec vitest run` (simulator manager, fleet-resource HTTP,
and fleet-resource CLI). The first landing run found an unused test variable;
the retained exact device is now explicitly asserted after proven seat exit.
The final landing-gate result and commit are attached to the issue.

The next gate passed all 29 typechecks but found the existing slow-boot
caller-disconnect test could abort at 400 ms before admission under suite load.
It now disconnects after the executable fixture logs `bootstatus`; a test-owned
file gate holds that command in flight until explicitly released. Assertions
still require the same admitted lease and exactly one create and boot.
