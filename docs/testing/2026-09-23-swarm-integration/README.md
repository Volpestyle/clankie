# Swarm integration verification

The integration is checked through the repository test suite and real host paths.
Detailed operator, account and session records are retained in the private
`clankie-ops` repository at `docs/testing/2026-09-23-swarm-integration/`, alongside
the corresponding Linear issue evidence. They are not public fixtures.

## Runtime and connection checks

- [Optional Herdr runtime](optional-runtime-proof.json): the service remains usable with execution disabled.
- [Real Herdr workers](live-proof.json): assignment, question, idle wake and completion.
- [Multiple execution runtimes](real-runtime-proof.json): inventory and input stay on the selected connection.
- [Remote coordinator over SSH](external-ssh-proof.json): separate coordinator access and scoped tool delegation.
- [App connection controls](app-only-proof.json): native device controls reach the host connection API.
- [Hosted coding image](hosted-proof.json): isolated owners, real worker execution and persistent state under a synthetic model.
- [Portable instructions](instructions-proof.json) and [selected skills](skills-proof.json): workers receive immutable assignment context.

## Native captain and paired app

Installed Claude captain and paired iPhone/iPad checks verify delegation to an
existing independent worker, result delivery to the selected conversation, and
restoration after app relaunch. Their account/session evidence is retained privately.

## Linear bot account and two workers

Two independently enrolled workers use the configured automation identity with
separate task-bound grants and provenance. Revoking one grant leaves the other
usable. Provider write scopes reject alternate parent and edit arguments.
Actual provider identities, issue IDs and write receipts are retained privately.

## Live human reply and Discord

A human issue comment reaches its existing conversation owner, which routes the
request to the existing worker, verifies completion, and publishes one automation
account reply. A subsequent Discord question receives the verified result through
the normal conversation path. The delivery receipt and restart recovery record
are retained privately. Interrupted-wake retry is covered by regression tests.

## Renewable access in a real worker

The [renewal check](renewable-worker-proof.json) exercises a real idle/resumed
worker beyond its initial enrollment expiry, then verifies tool removal after
revocation without restarting it. The provider is synthetic. This proves renewable
session authority; raw bearer rotation and post-revocation call refusal have
separate service regressions.

## Checks

Run `pnpm check` from the public repository. Worker access, conversation ownership,
native-seat routing and connection isolation have runnable regressions beside their
implementation. The private app and gateway run their own `pnpm check` against the
same public protocol. Real host evidence supplements these checks; synthetic
providers do not establish production credentials or managed tenant provisioning.
