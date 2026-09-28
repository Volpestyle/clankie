---
name: swarm-lead
description: Lead authorized agents through swarm-mcp task ownership, messages and handoffs. Default for an enrolled fleet; uses lead for shared review and delivery judgment.
---

# Swarm lead

Load `lead` for leadership judgment and `swarm-mcp` for the installed protocol.
Discover the available tools and sync the current scope before dispatch. Reuse
existing owned work. Keep one dispatch and integration authority.

Use Swarm for assignments, questions, blockers, decisions and completion notices.
Every participating worker loads `swarm-mcp`; leadership alone cannot establish a
shared protocol. Address stable actor IDs, not pane IDs or role labels. Keep the
message thread when replying. The configured work tracker holds deliverables and
evidence; no tracker is required for coordination. Execution runtimes such as
Herdr own terminals and processes. Use Swarm for communication even inside Herdr.
User-started agents can participate in the same reachable, authorized coordinator
scope; installing the same MCP alone does not connect separate coordinators.

Persist the objective, worktree, acceptance criteria, expected artifacts and
constraints in the task contract. Use `swarm_assign` with a configured route;
missing capability or uncertain dispatch is a condition to resolve under the same
intent, never permission to spawn again through a shell. Keep stable command IDs
on retries. Shared files require explicit ownership; workers preserve others' work.

Read the actual completion evidence and carry accepted work to its destination.
A task finish, processing acknowledgment, accepted review and integrated delivery
are different facts. Use runtime inbox delivery or bounded waits to receive work;
no model polling loop. Acknowledge a leased envelope only after processing it,
and deduplicate effects when the runtime redelivers it. After accepting a terminal
dispatched result, release its allocation through `swarm_task` cancel with its
original `intentId` and `taskId`; the provider verifies the fenced outcome. A
completed task alone does not release dispatch capacity.

Native children remain useful for private bounded work that fits their host and
lifetime. Cross-session ownership and handoffs use Swarm. Do not manufacture a
second task or relay every private child message through the lead.

If Swarm is unavailable, state the limitation. Use `herdr-lead` only for an explicit
fallback or unenrolled fleet. Never duplicate an uncertain assignment across both.

When leading Clankie's swarm, use the owner-connected tracker identity for every
tracker write, including hired workers. Use Clankie's connected tools or an
explicit worker grant; a worker without access asks the lead to make the write.
Never substitute the harness's own connector or a fixed account.
