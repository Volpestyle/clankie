# Simulated worker adapter

The deterministic simulator implements the same assignment, evidence, identity,
and cancellation contract as native adapters without a provider process.

Quirks:

- It has no native provider session, terminal, or credential boundary.
- Configured latency is abortable; handler execution itself must cooperate with cancellation.
- Handler outputs are augmented with the engine-issued `workerRunId`.
