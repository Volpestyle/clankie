# VUH-1686: goal activation uses owner authority

Candidate branch: `fix/vuh-1686`, based on approved `fix/vuh-1676` commit
`387b59ac3152a3c36570dcbfdb6c7c50d711afc1`. Pell owns landing the dependent batch.
All new credentials, device records, HTTP servers and goal state in these checks
are isolated fixtures. No live-service goals, restarts, account changes, sign-ins,
evals or full `pnpm check` ran.

## Authorized result

The shared captain bearer receives **403 `goal_owner_required`** for `set_goal`,
`accept_goal`, `set_goal_status: active`, and `set_enabled: true`. The last two
close resume paths for already accepted work. Read/status, pause, disable and
clear retain the captain route. These refusals leave durable autonomy state
unchanged.

The console selects its separate owner transport for those commands, with no
fallback to captain when the owner transport is missing or refused. The CLI uses
the existing operator credential broker:

```sh
clankie conversations goal global-default accept
clankie conversations goal global-default resume
clankie conversations goal global-default set --tokens 1000000 "Finish the checked task"
```

An active device with `terminalControl` also supplies owner authority. The captain
revalidates the presented authority after asynchronous fleet census, immediately
before changing durable state. Native goal refusal and budget accounting remain
in force.

## Evidence

- [HTTP authority integration](../../../apps/clankie/test/goal-activation-authority.integration.test.ts)
  uses the real HTTP app, captain, credential-backed authenticator, temporary
  file broker, signed device sessions and durable autonomy store. It proves
  captain/direct-call refusal, console and CLI accept/resume/set, device grant and
  expiry/revocation denial, and credential rotation during awaited census.
- [Native goal integration](../../../apps/clankie/test/native-goal-refusal.integration.test.ts)
  retains native ownership refusal through real HTTP/MCP with distinct owner
  and captain authenticators.
- [Console transport coverage](../../../apps/tui/test/operator-conversations.test.ts)
  and [CLI coverage](../../../apps/tui/test/conversations-cli.test.ts) prove routing,
  useful owner-auth failures, command validation and absence of captain fallback.
- [Pi execution integration](../../../apps/clankie/test/goal-execution-integration.test.ts)
  covers existing budget enforcement and zero-token failure/retry behavior.

## Checks

- Focused Vitest batch: **72/72 tests passed across five files** (authority,
  native HTTP/MCP, Pi execution, console transport and CLI).
- Typechecks: `@clankie/clankie`, `@clankie/protocol` and `@clankie/tui` passed.
- Changed-path lint/format, local Markdown links, retired-claim and whitespace
  checks passed.
- Independent read-only review found no required fixes in the protocol, HTTP or
  captain authorization delta.

## Remaining boundary and decision

This raises the activation bar: it requires a deliberate owner/device credential,
rather than the ambient captain bearer. It **does not** isolate against a
same-UID shell that reads Keychain or `device-session.key`. Native bridges already
use the operator bearer; local device signing keys are host-readable.

The lead explicitly scoped this issue to authorization and deferred protected
signing. [ADR 0130](../../adr/0130-goals-and-self-wakes-share-the-operator-thread.md)
records the remaining need for a separate OS principal or a non-exportable,
user-presence owner signer, such as Secure Enclave. No such signer was built.
