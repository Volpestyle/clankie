# Development guide

## Toolchain

- Node 24+
- pnpm 11+
- TypeScript 5.9
- Turbo
- Vitest
- oxlint and oxfmt
- Xcode for iOS/macOS shells
- optional Docker for local telemetry/sandboxes
- optional Codex CLI, Pi coding agent, and provider credentials

Run:

```bash
corepack enable
pnpm install
pnpm doctor
pnpm check
```

## Local service ports

- control plane: `4310`
- development relay: `4320`
- OTLP HTTP: `4318`
- local telemetry UI: see `infra/observability/README.md`

## Start the offline proof

```bash
pnpm eval:self-build
```

## Start operator surfaces

```bash
pnpm --filter @sapling/control-plane dev
pnpm --filter @sapling/tui dev
```

The TUI is built against `@earendil-works/pi-tui`, not Ink or a generic abstraction. Custom components must return lines no wider than the supplied width and should use the framework utilities for ANSI-aware truncation.

## Real provider readiness

```bash
codex --version
pi --version
printenv ANTHROPIC_API_KEY >/dev/null
```

Run provider contract smoke tests in disposable worktrees before enabling them in a mission. Keep provider integration tests opt-in and exclude them from credential-free CI.

## Apple app

The shared React Native source is present, but native iOS/macOS projects are not generated in this scaffold. Generate shells using versions pinned in `apps/apple-command-center/package.json`, then implement the `SaplingTerminalSurface` Fabric component with SwiftTerm. Keep terminal rendering native on Apple and xterm.js for a future web client.

## Adding a package

- use `@sapling/<name>`;
- expose TypeScript source during scaffold stage;
- include `typecheck`, `test`, and `clean` scripts;
- obey dependency direction in the architecture check;
- add unit tests for invariants, not just happy paths;
- document authority/security implications.
