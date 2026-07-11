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
- captain Eve session API: `4321`
- OTLP HTTP: `4318`
- local telemetry UI: see `infra/observability/README.md`

## Start the offline proof

```bash
pnpm eval:self-build
```

## Start operator surfaces

```bash
clankie
```

The launcher attaches to or starts the loopback captain service before opening
the TUI. For separate development processes:

```bash
pnpm --filter @sapling/control-plane dev
pnpm --filter @sapling/captain-eve exec eve dev --no-ui --host 127.0.0.1 --port 4321
SAPLING_CAPTAIN_URL=http://127.0.0.1:4321 pnpm --filter @sapling/tui dev
```

The TUI is built against `@earendil-works/pi-tui`, not Ink or a generic abstraction. Custom components must return lines no wider than the supplied width and should use the framework utilities for ANSI-aware truncation.

## Real provider readiness

```bash
codex --version
pi --version
printenv ANTHROPIC_API_KEY >/dev/null
```

Run provider contract smoke tests in disposable worktrees before enabling them in a mission. Keep provider integration tests opt-in and exclude them from credential-free CI.

`openai/<model>` uses an OpenAI API key. `openai-codex/<model>` uses the
ChatGPT subscription OAuth credential and the Codex Responses transport. The
provider identity is explicit so both credentials can coexist safely.

## Apple app

The shared React Native source is present, but native iOS/macOS projects are not generated in this scaffold. Generate shells using versions pinned in `apps/apple-command-center/package.json`, then implement the `SaplingTerminalSurface` Fabric component with SwiftTerm. Keep terminal rendering native on Apple and xterm.js for a future web client.

## Concurrent work through the tracker (interim)

Until the tracker connector lands ([VUH-764](https://linear.app/vuhlp/issue/VUH-764)), concurrent agent sessions coordinate on Linear directly under these rules:

- All agent sessions post as the single shared identity (`volpestyle+clanky@gmail.com`) — never a personal account or a per-agent seat. Sign every comment with agent name, role, and worker/session ID.
- Claim before starting: self-assign the issue and move it to In Progress, then re-read the issue to confirm the claim stuck. If another session claimed it first, pick a different issue.
- One issue per worker, one autonomous writer per worktree; declared write scopes must not overlap (`AGENTS.md`).
- Report results as issue comments using the completed-implementation evidence block from `AGENTS.md`.
- The lead session verifies against acceptance criteria and transitions issues to Done; an implementer never marks its own issue completed.

The tracker is authority for intent, priority, and acceptance criteria only. It is not a coordination mutex — conflict prevention lives in write scopes and worktree isolation.

## Adding a package

- use `@sapling/<name>`;
- expose TypeScript source during scaffold stage;
- include `typecheck`, `test`, and `clean` scripts;
- obey dependency direction in the architecture check;
- add unit tests for invariants, not just happy paths;
- document authority/security implications.

## Adding a skill

Skills live once under `.agents/skills` (the source of truth). The provider roots
`.claude/skills`, `.codex/skills`, and `.pi/agent/skills` mirror it with relative
symlinks, so they cannot drift — see [ADR 0008](adr/0008-symlinked-provider-skill-mirror.md).

- author or edit the skill under `.agents/skills/<name>`;
- run `pnpm skills:sync` to wire the mirrors and prune stale links;
- `pnpm check` runs `pnpm skills:check`, which fails if any mirror is not the
  correct symlink — never edit a provider copy directly.
