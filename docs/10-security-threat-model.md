# Security threat model

## Assets

- source code and private artifacts;
- provider/API credentials and subscriptions;
- GitHub/tracker/Figma/deployment authority;
- terminal control and local machine access;
- user/channel memory and voice transcripts;
- doctrine, approvals, audit history, and evaluation integrity.

## Adversaries and failures

- malicious repository or issue prompt injection;
- compromised skill/plugin/MCP server;
- model error or deliberate policy evasion;
- hostile Discord participant;
- stolen mobile device or relay token;
- worker process escaping scope/sandbox;
- terminal output exploiting renderer or misleading operator;
- insider changing doctrine/evals to conceal failure;
- cross-tenant routing bug;
- dependency or update compromise.

Minecraft adds hostile server operators, players, plugins, chat, signs, books,
resource packs, and protocol errors. Their content can attempt to impersonate
the operator, introduce tools, widen limits, solicit credentials, or turn an
ambient voice request into approval.

## Primary controls

- deny-by-default named capabilities;
- field-level authority and approval policy;
- isolated worktrees/processes and path locks;
- network deny/allowlist profiles;
- secrets in OS keychain/broker, not model context;
- short-lived capability grants;
- signed/pinned skills and reviewable diffs;
- device pairing, revocation, TLS, replay protection;
- single-writer terminal control leases;
- hash-chained semantic audit log;
- frozen evaluations and independent review;
- channel/memory visibility boundaries;
- emergency runner/workspace stop.

## Prompt-injection response

Treat all retrieved content as data. External instructions cannot alter doctrine, authority, tool permissions, write scope, or evaluation rules. When content asks for credentials, policy changes, unrelated actions, or hidden communication, emit a security event and block.

For Minecraft, chat, server text, signs, books, and plugin messages enter only
the explicitly untrusted observation field. The policy engine matches trusted
action metadata, lane/authority, allowlisted server/world bindings, goal
version, and numeric limits; it never parses game content into policy. Unknown
Minecraft capability names deny even when a connector risk class would
otherwise allow them.

## Minecraft action and channel boundary

- The gameplay lane receives only the tools projected for the active session
  phase and runner lease. TUI and Discord cannot forge the gameplay catalog.
- Local private observe, navigate, craft, break, place, interact, and optional
  hostile-mob combat require explicit rules with region, travel, duration,
  retry, block-change, and inventory-loss ceilings.
- Remote/public join, player combat, public chat, and server commands never
  inherit an allow from generic write risk. They need an explicit action rule;
  approval-gated rules accept only an authenticated-human approval.
- Discord voice is ambient. It may steer, pause, and disconnect, but cannot
  approve a privileged Minecraft action or capability expansion.
- Approval assumptions hash the exact action, server, world, goal version, and
  limits. A change invalidates the approval. Short-lived capability grants bind
  the same mutable assumptions and the source lane.

## Credential architecture

```text
worker requests named action
  → control plane builds ActionRequest
  → doctrine decision
  → human approval if needed
  → broker issues short-lived capability
  → privileged connector performs one operation
  → result and idempotency key recorded
```

A shell inside a worker cannot find a merge/deploy token because none is present.

Licensed Minecraft account credentials follow the same isolation with a
narrower store: the runner owns a dedicated macOS Keychain service, the
gameplay/captain/model processes receive only short-lived bounded grants, and
there is no plaintext file fallback. Microsoft/Minecraft access and refresh
tokens, session credentials, and raw authentication errors never enter events,
terminal summaries, model prompts, analytics, or support bundles. Credential
failures cross the boundary only as a stable error code and generic redacted
message.

## Incident procedure

1. stop affected runner/workspace;
2. revoke device, provider, and connector credentials;
3. preserve event/audit artifacts and worktrees;
4. identify first compromised event/process;
5. assess cross-channel/workspace exposure;
6. patch in isolated incident mission;
7. run security regression/holdout suite;
8. communicate and delete data according to policy;
9. restore from known doctrine/runtime version.
