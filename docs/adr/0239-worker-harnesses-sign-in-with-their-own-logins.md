# ADR 0239: Worker harnesses sign in with their own logins

Status: Accepted (2026-10-06). Amends the hosted ChatGPT gate of
[ADR 0052](0052-subscription-precedence-over-metered-api-key.md) and
[ADR 0197](0197-hosted-workers-reach-the-owners-model-through-the-body.md) for
native Codex seats only. Builds on
[ADR 0238](0238-hosted-claude-workers-trust-their-own-workspace.md).

## Decision

An owner can sign the Claude Code and Codex worker harnesses into their own
accounts from a paired device or the CLI, on every deployment (Mac,
self-run hosted and managed hosted), with no shell on the body:

- **Claude Code** runs its own `claude auth login --claudeai`. The owner opens
  the authorization link on any device, signs in to their Claude subscription,
  and sends back the code the page shows. A wrong code leaves the same sign-in
  waiting for another.
- **Codex** runs its own `codex login --device-auth`. The owner opens the link
  and enters the one-time code; Codex completes on its own.

The service only relays the vendor's link and code (vendor hosts only, to the
principal that started the sign-in) and checks the result with each harness's
own status command. Tokens are written by the harness into its own store under
the body user's home and never cross Clankie's API. The API, its authority (the
operator or a device holding Take Control) and its gateway route mirror model
sign-in; support access cannot call it. The hosted image installs Codex beside
Claude Code.

A signed-in Claude subscription takes precedence over an `ANTHROPIC_API_KEY`
the owner set on the body: the key is recorded as declined so hired Claude
workers use the subscription.

## Why

Owners want their existing Claude and ChatGPT subscriptions to power the
workers Clankie hires, including on hosted bodies where they have no terminal.
Both vendors ship device-friendly logins in their own clients for exactly this
remote case. Running the unmodified client's own login keeps Clankie out of the
token path; ADR 0197 already kept native unmodified Claude Code and Codex seats
on their own authentication.

ADR 0052/0197 gated hosted ChatGPT sign-in pending OpenAI approval for
Clankie's own model. James decided (2026-10-06) that a native Codex login the
owner performs in Codex's own client on their body is the owner's own client
authentication, like Claude Code's, and is offered on managed bodies too. The
gate for Clankie's own model (Pi `openai-codex` sign-in and forwarding on a
managed body) is unchanged.

## Alternatives

- **Self-hosted only for Codex** until OpenAI approval is recorded: consistent
  with ADR 0052/0197, but managed owners could not use their ChatGPT plan with
  Codex workers.
- **Claude only**: leaves Codex workers without a sign-in on hosted bodies.
- **Relay tokens through the broker**: puts subscription tokens in Clankie's
  path and makes Clankie refresh them; the native clients already do this.

## Consequences

- Hosted Codex workers can bill the owner's ChatGPT plan. If OpenAI's terms for
  remotely hosted offerings require it, approval remains an owner action; this
  decision does not imply one exists.
- Login links and codes are interaction data: never logged, persisted or put in
  conversation messages. The CLI shows them only on the terminal's stderr.
- The public gateway carries the new routes after the gateway is redeployed.
