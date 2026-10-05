# Composer transcription boundary evidence — 2026-10-05

VUH-1569 / VUH-1571. Code only, based on `origin/main` at
`b68678e8bf8f001e651bdd75fc5e20f2d16dfea2` in an isolated sibling worktree.
No live provider, eval, service restart, account change or deployment was run.

## Focused results

- Review gate: real paired/encrypted composer HTTP, signed hosted-body transport,
  hosted security, device projection and pairing regressions: **72/72 passed**
  across five files. The unchanged gateway encryption regression evidence is
  retained from the original gate.
- Typechecks for `apps/clankie`, `packages/protocol` and `packages/api-client`:
  passed. Scoped lint and `git diff --check`: passed.
- Public docs build: **10 pages, 56 network routes, 148 API operations**;
  links and anchors passed. Local Markdown links passed.

Reproduce the HTTP gate explicitly from the core root:

```sh
pnpm exec vitest run --config vitest.config.ts apps/clankie/test/composer-transcription.test.ts apps/clankie/test/hosted-body.test.ts apps/clankie/test/hosted-device-security.test.ts apps/clankie/test/devices.test.ts apps/clankie/test/pairing.test.ts
pnpm exec tsc --noEmit -p apps/clankie/tsconfig.json
pnpm exec tsc --noEmit -p packages/protocol/tsconfig.json
pnpm exec tsc --noEmit -p packages/api-client/tsconfig.json
pnpm --filter @clankie/docs check
```

The [composer HTTP check](../../../apps/clankie/test/composer-transcription.test.ts)
uses production pairing, device HMAC sessions, hosted-key restoration,
encryption, routes and SQLite receipts. Its external cloud boundary returns
fixture transcripts over HTTP. A 180-second PCM WAV with extra RIFF metadata
crosses the unchanged encrypted transport in bounded chunks. A 180001 ms WAV,
wrong PCM format, inactive/read-only/support devices, expired/revoked sessions
and operator/Clankie bearers cannot spend. Device-scoped receipts, cancellation,
lost responses and a body restart cannot resubmit audio. Outer transport,
event log and persisted SQLite contain no transcript/audio content.

If the allowance fills during upload, a validated pre-dispatch refusal returns
`failed` with `allowance_exhausted` for deliberate local recovery. An ambiguous
network/503 response returns `uncertain`. Neither outcome repeats that request ID.

The retention regression fills the actual SQLite table with 100,000 request
records and exercises the HTTP boundary: it refuses another request before
24 hours, then reclaims old records and accepts a new capture. Temporary audio
still expires after ten minutes. The hosted accounting hold independently
prevents replay after the body's 24-hour metadata retention ends.

Support provenance uses VUH-1367's exact `supportGrantId` record/event/offer
field. A hosted body confirms the immutable fleet marker from nonce-bound
signed security state before issuing the support session, during restore and
on first admission. An unconfirmed publication returns 503 without consuming
the pending pairing token. A confirmed publication survives restart, and the
device cannot use composer transcription. The fixture injects a trusted
support offer because VUH-1367's full grant routes are on a separate approved
branch; after integration its setup can use a real read-state grant/offer.

The paired-device API and node-free client are the headless seam. The launcher
does not store the companion app's paired session and has no new transcription
command or ambient-credential fallback. [API and retention bounds](../../composer-transcription.md).

## Unverified release evidence

These fixtures do not prove Apple microphone release, native linking, recording
container output, physical iPhone/iPad/Mac layouts, accessibility, model
availability, recognition quality or real-provider latency/cost. James owns
those checks, the provider and allowance decision, privacy publication and
deployment. Companion app and private hosted-service records hold their
separate evidence; nothing here claims the capability is deployed.
