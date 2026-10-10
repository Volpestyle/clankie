---
name: clankie
description: >-
  Use when you work beside a running Clankie, inside his Herdr (HERDR_ENV=1 with
  `clankie` on PATH) or as one of his agents, and the task touches anything that
  may route through him: conversations and their Discord channels, Linear,
  GitHub, Swarm, other agents' sessions, the fleet, machines or devices. Check
  what he has connected before calling a service unreachable.
---

# Beside Clankie

A lot routes through Clankie. Before you call a service unreachable, or ask the
owner for a token, ask him what he has. His connections are the owner's, not
yours: use them for the task you were given, and nothing wider.

This skill is for an agent working next to him. If you _are_ Clankie, load
`this-machine` instead.

## Ask him what is live

Never assume an inventory; it changes as the owner connects things. These print
JSON:

| Question                               | Command               |
| -------------------------------------- | --------------------- |
| How is this install put together?      | `clankie doctor`      |
| Are his services up?                   | `clankie status`      |
| Which runtimes, Swarm and accounts?    | `clankie connections` |
| Which owner accounts (Linear, GitHub)? | `clankie accounts`    |
| Which tool grants are open right now?  | `clankie access list` |

An account that reads `connected` or `verified` is usable through him. One that
reads `unconfigured` is the owner's to connect from the app or the CLI; say so
rather than working around it.

## Who you speak as

Every outward action is said by someone. Know who before you act:

- **The Clankie app**: Linear tool writes through a grant, and his own posts.
- **A worker persona**: `clankie linear post issue|comment --json-stdin` with an
  existing fleet `personaId`; Linear shows that worker's name and portrait.
- **The owner**: anything sent from the owner's own accounts. Never borrow them.

Posting to Discord, sending into someone else's conversation, or creating
tracked work the task did not ask for are outward-facing: ask the owner first
unless the task already authorizes it. Reading is fine.

## What routes through him

- **Conversations and Discord channels.** `clankie conversations list | show ID
| tail ID` reads any thread, Discord ones included. `clankie conversations
channels | rooms` lists agent channels and their Discord rooms, and `clankie
conversations channel ...` creates or edits one (`--discord provision` gives
  it a room). `clankie send --conversation ID` steers the active turn or queues
  a follow-up (`--delivery steer|queue`, `--attach PATH` for images and video).
  `clankie file publish --conversation ID PATH` puts one finished file into a
  thread.
- **Linear.** `clankie linear status | inbox | work list` reads what he follows.
  For Linear's own tools (search, read, create, update), open a short grant:
  [reference/grants.md](reference/grants.md). Load `linear-issues` for how to
  write, and `work-items` for posting a worker's result.
- **GitHub.** Connected through `clankie accounts` the same way as Linear; when it
  reads connected, grant its tools the same way.
- **Swarm.** `clankie swarm status | connections`, then contacts, tasks, a
  persona's thread, or a message to a persona. `swarm-mcp` covers the
  coordination tools.
- **Other agents.** `clankie agents list | read HOST:SESSION` reads any Claude,
  Codex, Grok or Pi session here or over SSH; `agents resume` restarts one;
  `agents role` gives a role. Resuming or steering someone else's agent is
  outward-facing.
- **Fleet and machines.** `clankie fleet`, `clankie terminal` and `clankie
runtime` show what runs where; changing capacity, workspaces or harnesses is
  the owner's call.
- **Devices and keys.** `clankie pair` mints a pairing code for the owner;
  `clankie keys status` says which model keys are set. Keys are write-only: never
  ask for one in chat.

When something you need is not in this list, `clankie connections` and his
README (its path is `repoRoot` in `clankie doctor`) are the authority, not this
page.
