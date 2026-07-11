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
