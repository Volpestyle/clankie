# Deploy holds

```bash
clankie update hold --holder 'Bram w3Z:p2N' --pane w3Z:p2N --reason 'live test' --minutes 30
clankie update holds
clankie update release HOLD_UUID --actor 'Clankie (lead)' --reason 'test finished'
clankie update --override-hold HOLD_UUID --actor James --reason 'test may end'
```

A deploy hold keeps runtime updates (`clankie update`, scheduled updates and the
machine session's update tool) from replacing the running service while someone
relies on it, such as a live test. It never holds `main`: pull requests merge
regardless. The routes are `POST /v1/deploy-holds` (owner only) and the hold
fields of `clankie update status`.

A hold records its holder, reason, creation time, `expiresAt` and optional
`--pane` or `--seat`. `--minutes` is required, from 1 to 60. At expiry the hold
lifts on its own: admission ignores it from that moment, and the service writes
an `expire` receipt naming the holder within about 15 seconds, even if nothing
reads the registry. To keep holding, place a new hold, which is a new visible
decision with its own receipt. Holds placed before this rule lift 60 minutes
after their creation. The runtime canary's own holds are the exception: they
end with their canary, and a failed canary's hold stays until the owner releases
or overrides it (see `clankie update --help`).

Use fleet-qualified IDs for remote holders. Status reports `present`, `gone`,
`unknown` (unavailable census) or `person`. A gone holder still holds until
expiry. `clankie fleet status`, the lead's periodic round and every `update`
refusal show each hold's holder, how long it has held and the time left.
Runtime-update admission and the registry share one lock, so a hold cannot race
an admission. Existing admitted deployments are not cancelled by a later hold.

The holder releases its own hold when done; the lead or owner releases anyone's
hold that has outlived its purpose. Every release, override and expiry is a
durable receipt with the hold (holder included), actor, reason and time;
`update holds` returns the latest ones and `release` returns its own. Only
the authenticated operator can override a hold for an update, explicitly naming
**every** hold with `--override-hold` plus `--actor` and `--reason`, or all of
them with `update --override-holds --reason TEXT`. The actor is an audit label,
not authentication. Overrides leave holds in place.

Holds live in the service state's `integration/` directory, a name kept from the
retired integrate queue so existing holds survive the upgrade.
