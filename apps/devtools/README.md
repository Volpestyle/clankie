# Developer replay tools

Inspect a self-build run without a live control plane:

```bash
pnpm --filter @clankie/devtools dev timeline artifacts/evals/self-build/self-build-events.jsonl
pnpm --filter @clankie/devtools dev garden artifacts/evals/self-build/self-build-events.jsonl
pnpm --filter @clankie/devtools dev status explain <workerRunId|captain> artifacts/evals/self-build/self-build-events.jsonl
```

Use `audit` for a hash-chained `JsonlEventStore` file.

`status explain` replays Tier-0/1/2 semantic signals and prints the authoritative state, the winning tier/source/confidence/timestamp, the complete signal chain, and any Tier-2 attention-only proposals. It reads semantic domain events only; terminal frames are never an input.
