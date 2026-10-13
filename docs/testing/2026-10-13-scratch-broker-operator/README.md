# LOCAL-VUH-14: disposable broker operator setup

Tracks: `clankie-work://local/issue/0d5e1529-cf1e-4f25-ab20-512de8fdc559`

The separate `--broker-operator` preset uses normal service first-run minting in
its private file broker. The legacy preset and canonical guards are unchanged.
The same-preset source CLI performs the protected reads, with no real credentials,
GUI, caller/grant substitution or alternate API.

## Verified result

Real isolated service + relay, before fixture seeding or pairing:

- Ordinary `auto off` setup, then status `off`.
- `project list`: no projects, assignments or role-write receipts.
- `model status`: selected/effective null, providers empty.
- `devices --json`: empty; `body status`: no leases.
- `work status`: no configured tracker; `needsDecision=true` and no signals.
- Original environment-only and mismatched credentials both refused with
  `Project settings require the canonical operator credential`.
- Existing/nonempty and symlinked roots refused; original preset bytes retained.
- Ordinary pairing offer/redeem/complete: 200; relay settings: 200; after ordinary
  device revoke, relay settings: 401.
- Broker at `<scratch-root>/credentials.json`, mode 0600; exact matching loopback
  targets, private HOME/state/settings/config/resources. Owned processes stopped
  and entire scratch root, including broker, removed by teardown.

Focused real-stack check passed twice; final run 11.79 seconds. Focused lint passed.
The first attempted proof found fresh Auto defaults on. It was corrected by using
ordinary `auto off` setup, preserving product defaults. Earlier VUH-2047 rejected
presets and evidence were not edited or reused. No model/provider, project or
tracker was seeded. This proves the supported disposable route; it does not prove
VUH-2047 UI acceptance or authorize real account/pairing changes.

## Evidence

`report.txt` contains the final raw protected-read results, exact private paths and
targets, refusal text, pairing/revocation results, teardown, focused check output
and source diff. Its evidence-store reference is in `evidence.json`.

Source base: `30ef4e9dd5ec3b5c3d0ae68bc6191b4863c138f9`. Changes are confined to `scripts/scratch-stack.mjs`,
its real-stack acceptance test, `docs/cli.md` and the shipped Clankie skill.
The integration receipt and exact landed SHA will be posted on the local issue.
