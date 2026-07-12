# Product thesis and commercial shape

## Category

Clankie is a local-first **agent fleet operating system embodied as a persistent teammate**. Underneath: heterogeneous-worker leadership, visible execution, artifact verification, policy enforcement, and human control. On top: one continuous character with memory, personality, and presence in the places a team already lives.

The primary product object is a Mission. Chat, Discord, voice, TUI, graph, garden, and mobile are channels and projections over shared mission state.

## Presence and personality

Presence is ambient supervision: the agent inhabits the team's social space and speaks when mission state crosses an attention threshold, so oversight happens where the team already is. Personality is the trust layer that makes supervision cheap—one consistent, legible character whose memory carries the working relationship (repositories, doctrine preferences, past mistakes) across sessions and channels.

Personality is data, never authority. A persona definition (`soul.md`) shapes tone and presentation; it cannot alter doctrine, permissions, routing, or evidence requirements. Ambient channels carry reduced command authority: voice and chat can steer and query, while approvals require an authenticated surface. See `04-doctrine.md`.

## Core promise

A user supplies an outcome. The lead:

1. retrieves authoritative context;
2. proposes a reviewable plan;
3. assigns bounded tasks to Codex, Claude Agent SDK, Pi, local models, or generic shells;
4. isolates writers in worktrees/sandboxes;
5. monitors semantic progress and terminals;
6. detects and repairs failures;
7. synthesizes verifiable artifacts;
8. asks for human authority at irreversible boundaries.

## Product surfaces

- **Lead (Captain):** persistent persona, memory, and mission leadership through Eve.
- **Doctrine:** predefined knobs and exact organization policy.
- **Runner:** trusted local execution and credential boundary.
- **Garden:** spatial fleet control and attention management.
- **Graph:** dependencies, delegation, artifacts, and conflicts.
- **Terminal deck:** raw inspection and takeover.
- **Artifact room:** diffs, checks, screenshots, designs, and deployment evidence.
- **Channels:** TUI, Discord bot/voice, web, iOS, and macOS.

## Open source

Open the components users need to trust and extend:

- event and runner protocols;
- local runner and terminal bridge;
- doctrine schema/evaluator;
- mission engine and local event store;
- TUI and reference desktop clients;
- worker/channel adapter SDKs;
- default profiles, skills, and evals.

Recommended license: Apache-2.0 for the community runtime and SDKs, with a trademark policy and optional commercial embedding/OEM terms.

## Monetize

- hosted remote relay and push notifications;
- shared missions, approvals, comments, presence, and history;
- organization policy inheritance, RBAC, SSO, SCIM, and audit retention;
- managed OAuth/connectors, secret brokering, voice/STT/TTS, and runner fleets;
- replay, evaluation analytics, cost attribution, and incident investigation;
- private/verified skill and adapter registries;
- enterprise deployment, data residency, support, and SLAs;
- marketplace revenue share and commercial embedding.

Charge per human operator, connected runner/fleet, and managed usage. Avoid making “per spawned agent” the primary meter; that taxes the central product behavior.

## Durable moat

The moat is the accumulated operational system:

- a stable cross-provider protocol;
- trusted local execution;
- high-quality adapter semantics;
- doctrine and governance;
- evaluation data about what leadership strategies work;
- remote/mobile control;
- a verified ecosystem of skills and workflows;
- the garden interaction model, persona and memory continuity, and persistent user attachment.
