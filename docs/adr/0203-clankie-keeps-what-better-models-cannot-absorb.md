# 0203 — Clankie keeps what better models cannot absorb

Status: accepted (James, 2026-09-30). Amended by
[ADR 0207](0207-work-records-and-native-agent-delivery.md): Swarm is optional and
automated agent delivery no longer falls back to terminal typing.

Date: 2026-09-30

## Context

After the rewrite, Clankie is about 125k lines of TypeScript across 10 apps and
20 packages, with 164 ADRs, about 26 KB of standing instructions loaded every
turn, and 35 bundled skills. On 2026-09-29 every observed failure came from the
glue, never from the work itself:

- the memory card piled up copies in the seat;
- one Swarm disconnect failed every seat tool;
- `hire_agent` briefs arrived truncated because they were typed into a terminal;
- a stale headed browser daemon outlived restarts;
- live and catch-up Discord ingress used different addressing policies;
- a lost token rotation during sleep signed the Mac out of the gateway;
- the app had no fallback from the gateway route.

Harnesses and models keep absorbing layers that projects build on top of them
(skills, custom loops, memory, subagents). Extra layers can cost tokens and
make results worse once the underlying tools improve.

## Decision

Clankie is a workspace extension, not a custom agent harness. He bridges the
tried-and-tested harnesses (Claude Code, Codex and others) into one simple
system for the owner, and adds what they don't: a living character with rich
Discord and voice presence, the garden view and art, direct terminal
connections, and fun on top of productive swarm management. The agents do what
they do best in their own harnesses; Clankie gives them what they need to
succeed inside his system.

Every feature and every line of code must justify itself by at least one of:

1. it brings life or character to Clankie; or
2. it gives the owner something the Claude Code and Codex ecosystems don't.

Custom-harness code, which re-implements what a lab harness already does, fails
both and is cut. As a check on the second criterion, each part must also pass:
**would it still be needed if Claude and Codex were twice as good tomorrow?**
(Amended 2026-09-30 at James's direction: "be ruthless".)

- **Keep and invest:** his identity and memory across rooms; his bodies (Discord
  text and voice, the app, play); communication across vendors and machines
  (Swarm); trust boundaries; one tracker identity.
- **Make thin:** control of other harnesses and process scaffolding. Clankie
  hires, briefs, messages and learns completion through the harness's own
  extension points while the worker stays the real interactive harness in its
  herdr pane: Clankie's Claude Code plugin (channel notifications in, Stop hooks
  out) and the app-server of the pane's own Codex session. Workers are never
  replaced by a headless process with herdr as a mere view, so everything the
  labs ship keeps working and the owner can type into any seat. Terminal typing
  remains only a fallback. (Amended 2026-09-30 at James's direction.)
- **Delete:** duplicated instructions, rules written for older models, and
  surfaces nobody uses weekly.

First-class surfaces are the **app**, **Discord text and voice**, and the
**TUI**. The macOS **menu bar is retired**. Discord has two supported paths,
and both stay possible: the **official bot** (with the Activity as its
watch-me-play surface) and the **user-session body** (the only path Discord
allows for Go Live and watching screen shares). The surface review's proposal to
retire either is declined (James, 2026-09-30).

"Always on" may be a hosted body or an awake Mac; the owner chooses, and
Clankie treats host sleep as a normal condition to recover from rather than as
an error.

Every optional dependency must degrade to its own absence, never take the
whole service down. Standing instructions shrink to identity, trust boundaries
and where things live; procedure moves to on-demand skills. A standing
instruction or skill stays only if an A/B eval shows it helps. Evals run on
the owner's existing Claude and Codex subscriptions, not metered API budget.

## Consequences

- An eval set and runner come first; instruction and skill cuts follow its
  results rather than taste.
- `lead`, `swarm-lead` and `herdr-lead` merge into one leadership skill.
- Files over roughly 3,000 lines split by domain as their areas are touched.
- Superseded ADRs are marked archived, and one current-state architecture
  document is maintained, so agents stop reading dead designs.
- Work is tracked in the Linear project "Clankie overhaul".
