# 0203 — Clankie keeps what better models cannot absorb

Status: accepted (James, 2026-09-30)

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

Each part of Clankie must pass one test: **would it still be needed if Claude
and Codex were twice as good tomorrow?**

- **Keep and invest:** his identity and memory across rooms; his bodies (Discord
  text and voice, the app, play); communication across vendors and machines
  (Swarm); trust boundaries; one tracker identity.
- **Make thin:** control of other harnesses and process scaffolding. Clankie
  hires, briefs, messages and learns completion through each harness's
  programmatic interface (Claude Agent SDK or headless mode, Codex app-server).
  Herdr becomes the owner's view and takeover seat, not the control channel;
  terminal typing remains only a fallback.
- **Delete:** duplicated instructions, rules written for older models, and
  surfaces nobody uses weekly.

First-class surfaces are the **app**, **Discord text and voice**, and the
**TUI**. The macOS **menu bar is retired**. The Discord Activity and the
user-session lab body must justify themselves in the surface review.

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
