<div align="center">

<img src="branding/clankie-logo-512.png" alt="Clankie" width="200" />

# Clankie

**A persistent agent with a life of his own.**

Clankie hangs out in your Discord — text and voice — plays Pokemon and
Minecraft live on a watch surface, draws pictures, makes videos, browses the
web, remembers people and what happened yesterday, and codes. When work is
bigger than one pair of hands, he leads a fleet of coding agents through
herdr panes you can watch.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![built on pi](https://img.shields.io/badge/agent-pi-7c3aed?style=flat-square)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

---

## What he does

- **Discord teammate.** A real member of your server: bounded text turns,
  consented group voice, pictures ride his replies, and he remembers the
  people he talks to. He can also stay silent — silence is a real answer.
- **Plays games on stream.** Pokemon FireRed/Emerald on his own GBA body,
  Minecraft through mineflayer — watchable live in a Discord Activity, with
  voice commentary over the run. External agents can possess the GBA body
  through `apps/gba-mcp`.
- **Makes things.** Image and video generation behind one provider-neutral
  seam (OpenAI, Google, Grok); a browser via the agent-browser MCP host.
- **Codes and leads.** The same pi coding tools every agent has, plus the
  herdr CLI for fanning work out to visible agent panes — from the console,
  and from Discord when the person asking is on the system-actor allowlist.
  No mission protocol — he delegates, watches, and reports what actually
  happened.
- **One Clankie everywhere.** The TUI, Discord, voice, and gameplay are rooms,
  not separate agents: he can read his other rooms, and his persona is
  owner-authored settings, never caller input.

## Get started

Requirements: Node 24+, pnpm 11+, Git.

```bash
corepack enable
pnpm install
pnpm doctor          # toolchain and credential status
pnpm cli:install     # symlink the `clankie` launcher into ~/.local/bin
clankie              # start the service and open the TUI
```

Secrets live in the credential broker (macOS Keychain, or a mode-0600 file
store elsewhere) — there is no `.env` file. Configure from inside the TUI:
`/auth` for provider keys or OAuth, `/model` for the captain model,
`/image-model` for generation, `/persona` for who he is, `/connect` for
Linear, email, and Discord.

## Apps

| App                         | What it is                                       |
| --------------------------- | ------------------------------------------------ |
| `apps/clankie`              | The service: captain, tools, bodies, API (:4310). Catalog: `apps/clankie/openapi.yaml` |
| `apps/tui`                  | Operator console and the `clankie` launcher      |
| `apps/discord-bridge`       | Official bot: text, voice, attachments           |
| `apps/discord-user-session` | Personal-lab user-session body (off by default)  |
| `apps/discord-activity`     | The watch-me-play surface                        |
| `apps/gba-mcp`              | His GBA body as an MCP server                    |
| `apps/relay`                | Remote access for the phone/desktop app          |

`integrations/` holds the game bodies (gba-emulator, minecraft-mineflayer);
`packages/` holds the shared contracts. The graphical garden app is a separate
private repo (`clankie-app`).

## Development

```bash
pnpm typecheck
pnpm test
pnpm check           # fmt, lint, docs links, typecheck, tests
pnpm gba:free-play   # drive the GBA body from a CLI
pnpm discord:readiness
```

See [`docs/architecture.md`](docs/architecture.md) for the system shape and
the decisions behind it, and [`AGENTS.md`](AGENTS.md) before pointing a coding
agent at this repo.

## License

Apache-2.0. Third-party dependencies retain their own licenses; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
