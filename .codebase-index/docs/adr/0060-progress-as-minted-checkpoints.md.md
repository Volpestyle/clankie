# docs/adr/0060-progress-as-minted-checkpoints.md

Play progress survives as minted checkpoints —
sibling identities beside the frozen fixtures,
never mutations of them. `writeGbaCheckpoint`
captures core state plus a receipt and a
companion scenario that boots through the same
fail-closed digest-verified loader.

Read for the rules: nothing ever overwrites an
existing identity; loads verify id, ROM/core
provenance, and digest before touching the core;
save/load are lease-gated MCP tools (absent on
the deterministic double); a checkpoint scenario
is a boot anchor, not a route to replay. Bytes
stay operator-local; only digests travel.
