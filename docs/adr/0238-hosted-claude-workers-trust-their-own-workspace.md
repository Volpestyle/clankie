# ADR 0238: Hosted Claude workers trust their own workspace

Status: Accepted (2026-10-06). Narrows, for hosted bodies only, the rule that a
hire never accepts folder trust or answers permission prompts. Builds on
[ADR 0237](0237-hosted-bodies-update-themselves-to-official-releases.md).

## Decision

On a hosted body (the image in `scripts/release/clankie-linux.Dockerfile`), the
image and the body's start prepare Claude Code so a hired Claude worker runs
without an owner at its pane (VUH-1767):

1. **Channel approval.** The image writes Claude Code's managed policy,
   `/etc/claude-code/managed-settings.json`, enabling channels and allowing the
   `clankie-worker@clankie` channel plugin. The image builder is that machine's
   administrator.
2. **Worker plugin and session hook.** Every body start registers Clankie's
   marketplace from `/state/install/current/integrations/claude-plugin`,
   installs or updates `clankie-worker@clankie` (left disabled; each hire
   enables it for its own session) and installs Herdr's Claude hook.
3. **First-run state.** Claude's cosmetic onboarding is marked done, and an
   `ANTHROPIC_API_KEY` the owner set on the body is recorded as approved (its
   last 20 characters, as Claude stores it).
4. **Workspace trust.** `/workspace`, the owner's persistent project storage,
   is marked trusted. Folders elsewhere keep Claude's trust prompt, which a hire
   still never accepts.
5. **Permission mode.** The body user's Claude default permission mode is
   `auto`: Claude's own safety classifier approves routine edits and commands
   and refuses risky actions. An owner's own default mode is kept.

Macs are unchanged: their owner answers channel consent, trust and permission
prompts at the pane.

## Why

Hosted Clankie has to just work, and nobody watches a hosted worker's pane.
Without these, every hosted Claude hire stopped at a plugin, onboarding, trust,
API-key or permission prompt, so hosted bodies could not hire Claude at all
(`pnpm hosted:smoke` failed from VUH-1458 on). The hosted container serves one
owner, has no host access or Docker socket, and its workers already execute code
in `/workspace`, so trusting that workspace and letting Claude's classifier gate
actions adds little exposure inside the boundary the body already is.

## Alternatives

- **Owner approves each folder or prompt** through the app's terminal control:
  safest, but a managed owner would have setup steps and hires stall unwatched.
- **Trust only directories Clankie creates**: repos the owner points at would
  still stall; more code for little gain inside a single-owner container.
- **`acceptEdits` instead of `auto`**: shell commands would still prompt, so
  most real work would still stall.

## Consequences

- Repositories cloned under `/workspace` run their project Claude settings and
  hooks without a review prompt on hosted bodies.
- Hosted Claude actions are bounded by Claude's auto-mode classifier, not by a
  person; its refusals surface in the worker's own transcript.
- The hire code also recognises Claude Code 2.1.281's reworded trust prompt, so
  a blocked hire anywhere reports `trust_required` instead of a vague start
  failure.
