# Real-app run

One command that runs the real Clankie and checks what the owner would notice
([ADR 0309](../../docs/adr/0309-the-real-app-runs-on-every-change.md)):

```sh
pnpm real-run                          # every flow, about a minute
pnpm real-run --only project,feed      # boot plus the named flows, in order; name
                                       # the flows a flow builds on (feed needs project)
pnpm real-run --out DIRECTORY --keep   # keep the scratch home for a look
```

It starts this checkout's service and relay as plain Node in a new scratch home
(`scripts/scratch-stack.mjs --broker-operator`): its own HOME, state, settings,
credential file, free ports and private bundled Herdr. It never reads or writes
the owner's `~/.config/clankie`, live service, Keychain or Herdr sessions, and
calls no model. Run it through `clankie heavy --` on a shared machine.

Each flow drives the headless CLI and HTTP the way an agent or the app does and
checks the outcome through the API, the files the service wrote and the service's
own structured log. The run fails on the first failed flow, or if the service
logged anything at error level. Exit 0 means every flow passed.

The output directory (default `.local/real-run/TIME`) holds:

- `report.json`: each flow, what it proves, its outcome and time, and the
  service's errors and distinct warnings;
- `run.jsonl`: the run's Effect log, one JSON line per event, CLI calls included,
  with the flow and span timings;
- `home/service.log` and `home/relay.log`: the processes' own logs.

A passing run removes the scratch state unless `--keep` is given; a failing run
keeps it.

## Adding a flow

Add an entry to `flows` in [`src/flows.ts`](src/flows.ts): a `name`, one line of
what it `proves` in the owner's terms, and a `run` that uses `stack.cliJson`,
`stack.http` and `stack.serviceLog`. Check behaviour the owner relies on, never
incidental detail such as exact copy, field order or file counts that may change.
Flows run in order and may read what earlier ones left in `state`.
