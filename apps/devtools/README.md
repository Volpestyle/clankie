# Developer replay tools

Inspect a self-build run without a live control plane:

```bash
pnpm --filter @sapling/devtools dev timeline artifacts/evals/self-build/self-build-events.jsonl
pnpm --filter @sapling/devtools dev garden artifacts/evals/self-build/self-build-events.jsonl
```

Use `audit` for a hash-chained `JsonlEventStore` file.
