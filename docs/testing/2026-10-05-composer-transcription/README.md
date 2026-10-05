# Composer transcription boundary evidence — 2026-10-05

VUH-1569 / VUH-1571. Code only, based on `origin/main` at
`b68678e8bf8f001e651bdd75fc5e20f2d16dfea2` in an isolated sibling worktree.
No live provider, eval, service restart, account change or deployment was run.

## Focused results

- Real paired/encrypted composer HTTP and signed hosted-body transport:
  **36/36 passed** across two files. Unchanged gateway and hosted-device-security
  regressions previously passed **17/17**.
- Typechecks for `apps/clankie`, `packages/protocol` and `packages/api-client`:
  passed. Scoped lint and `git diff --check`: passed.
- Public docs build: **10 pages, 56 network routes, 148 API operations**;
  links and anchors passed. Local Markdown links passed.

Reproduce the HTTP gate explicitly from the core root:

```sh
pnpm exec vitest run --config vitest.config.ts apps/clankie/test/composer-transcription.test.ts apps/clankie/test/hosted-body.test.ts
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
