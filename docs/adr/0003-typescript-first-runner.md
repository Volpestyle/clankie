# ADR 0003: TypeScript-first runner with stable protocol boundary

Status: accepted for the proof stage.

TypeScript maximizes iteration speed and code sharing while product semantics are unsettled. Process, PTY, sandbox, and credential interfaces are isolated so high-risk/performance-sensitive runner components can later move to Rust without rewriting mission, UI, or provider contracts.
