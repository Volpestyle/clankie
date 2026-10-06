# Manual trust and delivery failure scenarios

[VUH-1522](https://linear.app/vuhlp/issue/VUH-1522): optional checks James or an agent can walk before a release.
These checks run only when explicitly requested; they add no CI, `pnpm check`, release-gate or eval work.
This checklist records no executed passes. Automated links describe coverage at `f5ed6ccb`, not live proof.

## Before starting

- Use disposable state, conversations, test-owned panes and consenting rooms. Fault only processes/links you own.
  Use synthetic providers or an existing dedicated nonproduction tracker; never run fault tests on the real Linear workspace.
- Record service/client/native-harness SHAs or versions, conversation/seat/room IDs, actor identity and UTC times.
  Give each action a unique `VUH-1522-CASE-RUN` marker; retain original request, delivery, hire and provider IDs.
- Start with `clankie doctor --json`, `clankie agents contacts` and `clankie conversations list`.
  Inspect saved transcripts with `clankie agents read local:UUID --tail 60` (use the discovered session reference); a tool acknowledgement alone is not a pass.
- Select cases relevant to the release. Missing fixtures, consent or implementation mean **unavailable**, not pass.
  Never repair uncertainty by resending, terminal typing, accepting an approval or using another account.
- VUH-1672/1677/1688 repairs are queued at this base. Their cases state release acceptance; verify the installed revision.
  Live model behavior, multi-person audibility and real provider/hosted boundaries remain **manual-only**.

## Checklist

### 1. Worker report bounces or has an unresolved receipt — [VUH-1615](https://linear.app/vuhlp/issue/VUH-1615), [VUH-1657](https://linear.app/vuhlp/issue/VUH-1657)

- [ ] **Setup:** Parent-launched test worker; record exact parent/child native sessions. In the fixture, omit the durable hiring/adoption binding.
- **Action:** Send one marked `message_clankie`; restore the bridge after a lost response. Restart after acceptance, then replace the test occupant.
- **Expected:** Route names the eligible parent or documented fallback, with a durable fallback reason when needed. Queued reports recover once;
  interrupted attempts stay uncertain without replay. Accepted ID/destination remain fixed; replacement occupants gain no report/control authority.
- **Look:** `clankie agents reports --conversation ID --limit 20`, doctor parent binding, durable inbox/receipt and recipient transcript.
  Acknowledge only observed reports with `clankie agents reports ack DELIVERY_ID --conversation ID`.
- **Automation:** [worker routing](../../apps/clankie/test/worker-lead-integration.test.ts), [process-death recovery](../../apps/clankie/test/inbound-report-recovery.integration.test.ts); live native acceptance is manual-only.

### 2. Async worker question never reaches the lead — [VUH-1633](https://linear.app/vuhlp/issue/VUH-1633), [VUH-1688](https://linear.app/vuhlp/issue/VUH-1688)

- [ ] **Setup:** Hired interactive Codex 0.160 worker with its app-server control channel; record worker, lead and current turn IDs.
- **Action:** Ask it to call `request_user_input_async`. Answer through `message_seat` using `questionAnswer.requestId =` the observed function `call_id`,
  `answers: {QUESTION_ID: {answers: ["chosen answer"]}}`, and no `message`. Repeat with sync input; separately race an owner answer in the pane.
- **Expected:** Lead sees text, question IDs and requestId; roster says waiting on a question. Answer steers an active turn without interruption or starts a native turn if idle.
  If confirmation finds the lead's reply and a different-client owner reply to the same question IDs, return `unconfirmed` / `answered_concurrently_by_owner`.
- **Look:** Hiring conversation, pane question, app-server turn/userMessage receipts and clientIds. On restart, answered/older completed questions do not re-notify;
  the latest unanswered async question remains available.
- **Automation:** [sync control](../../apps/clankie/test/codex-user-input.test.ts), [protocol fixtures](../../apps/clankie/test/codex-app-server.test.ts); async/race/restart acceptance is manual-only at this base (VUH-1688 queued).

### 3. Esc leaves queued messages stuck — [VUH-1688](https://linear.app/vuhlp/issue/VUH-1688), [VUH-1613](https://linear.app/vuhlp/issue/VUH-1613)

- [ ] **Setup:** Active test Codex worker. A queue subcase requires a supported route with actual `queued` receipts; `steered` is a different control.
      Ordinary follow-ups are refused while a blocking native question is pending; do not treat that refusal as queuing.
- **Action:** Press Esc in the test-owned pane, then send two marked follow-ups after idle. Separately interrupt a supported queued route;
  also hold a cold preparation dependency in a disposable Pi service with its event loop live.
- **Expected:** Aborted native turn releases admission immediately; follow-ups deliver once without stale `queued_until_turn_end`. Supported queued messages drain in order.
  Pi preparation stalls after five minutes without progress, emits `conversation_turn_stalled` and releases later inputs; releasing the dependency causes no late work.
- **Look:** Native terminal turn status, delivery IDs/transcript, conversation run journal and service log. A live tool within its timeout must not be mistaken for stalled preparation.
- **Automation:** [service cancellation](../../apps/clankie/test/operator-conversation-cancel.test.ts), [driver watchdog](../../apps/clankie/test/captain-conversation-driver.test.ts); native Esc is manual-only at this base (VUH-1688 queued).

### 4. Queued request produces only a plan — [VUH-1522](https://linear.app/vuhlp/issue/VUH-1522)

- [ ] **Setup:** Busy test worker with a supported after-turn queue in a disposable repo; prepare a tiny specified file edit and focused check.
- **Action:** Queue that marked task through `message_seat`, then let the first turn finish normally. Observe the next turn through completion.
- **Expected:** The requested artifact and check result appear, or a concrete question/refusal explains the blockage. Delivery followed only by a promise or plan fails this case.
- **Look:** Original message receipt, native transcript, `git diff` and command output. If the route steers instead, record a steering control; queue case is unavailable.
- **Automation:** [next-turn mailbox](../../apps/clankie/test/next-turn-mailbox.test.ts) covers transport; task execution is **manual-only**.

### 5. Worker bridge hangs, returns 403 or loses its catalog — [VUH-1651](https://linear.app/vuhlp/issue/VUH-1651), [VUH-1653](https://linear.app/vuhlp/issue/VUH-1653), [VUH-1677](https://linear.app/vuhlp/issue/VUH-1677)

- [ ] **Setup:** Connected test worker plus controlled bridge/proxy. Record discovered tools, request deadline and successful harmless read.
- **Action:** Separately delay an owned upstream request, revoke its fixture transport admission (403), and retire/refresh its catalog stream; reconnect and repeat discovery/read.
- **Expected:** Bounded failure with route/status evidence; revoked access stays denied. Restored authorized transport exposes the current catalog and completes the read.
  A cached tool name or successful health ping alone does not pass; no fallback into another service/account.
- **Look:** Native tool catalog, doctor, elapsed time, HTTP status and bridge generation/close events; native Codex may need an exact-session MCP reconnect.
  Project-tool revocation does not revoke connected fleet tools. Redact grants/descriptors.
- **Automation:** [MCP startup/catalog fixtures](../../apps/clankie/test/hired-catalog-bridge.test.ts), [HTTP catalog health](../../apps/clankie/test/tool-catalog-health.test.ts); admitted hangs/concurrent live hires are manual-only here (VUH-1677 queued).

### 6. Linear write times out after succeeding — [VUH-1638](https://linear.app/vuhlp/issue/VUH-1638), [VUH-1595](https://linear.app/vuhlp/issue/VUH-1595)

- [ ] **Setup:** Synthetic Linear endpoint or issue in a separate nonproduction workspace. For journaled `clankie work write`, choose assignment, label or dependency with an explicit request ID;
      separately test one marked raw MCP comment/patch.
- **Action:** Drop only the response after the provider records the effect; restart the test service. Read the original journaled receipt and issue instead of writing again.
- **Expected:** Exactly one effect; journaled receipt or typed uncertainty survives. Raw MCP comment/patch requires independent provider readback, not a work receipt.
  Timeout never implies rollback or permission to use a fresh ID; missing raw-write receipt support remains a gap.
- **Look:** `clankie work receipt ID --request-id UUID` for supported work writes, provider readback/IDs and `work-write-receipts.json`.
  `linear-writes.json` is an own-revision echo journal, not a general intent receipt lookup.
- **Automation:** [write/restart boundary](../../apps/clankie/test/work-item-write.integration.test.ts), [connected MCP receipts](../../apps/clankie/test/linear-connected-receipts-integration.test.ts); real provider behavior is manual-only.

### 7. Ambient room speaker reaches operator authority — [VUH-1672](https://linear.app/vuhlp/issue/VUH-1672)

- [ ] **Setup:** Consenting text and voice rooms; owner, friend with no effective grant, individually granted friend, guild/channel-granted nonowner and excluded-channel actor.
      Record `clankie discord status`, effective grants and head harness; use harmless marker files and synthetic private memory.
- **Action:** Each actor requests a handoff; two speakers ask concurrently. Revoke a grant before harvest, test missing speaker identity/crosstalk, then try to approve privileged work from ambient voice.
- **Expected:** Speakers without effective grants or verified speaker identity gain no machine tool; room grants expose no operator-private memory. Revoked work cannot harvest authority;
  paraphrase/crosstalk never changes a capture's verified actor. Approval-shaped results go to the authenticated surface; ambient voice cannot approve.
  **Queued VUH-1672 acceptance:** Visible bounded parallel threads/results return to the asking room. Only the OWNER gets a native Codex child;
  every nonowner uses Pi with its grant's tools. Claude children stay restricted; one speaker cannot steer another. This base serializes voice asks.
- **Look:** Dock/app active threads, child harness/tool inventory, actor/delivery IDs, grants at admission/harvest, actual effects and approval handoff.
- **Automation:** [grant matrix](../../apps/clankie/test/system-authority.test.ts), [speaker steering](../../apps/clankie/test/captain-voice-steer.test.ts) are partial; parallel/native-child acceptance is manual-only here (VUH-1672 queued).

### 8. Linear webhook forgery, self-echo or burst duplication — [VUH-1549](https://linear.app/vuhlp/issue/VUH-1549), [VUH-1678](https://linear.app/vuhlp/issue/VUH-1678)

- [ ] **Setup:** Disposable webhook service with fixture signing secret, known owner/app/worker identities and configured ordinary-chat target; record `clankie linear status`.
- **Action:** POST to `/v1/hooks/linear`: bad signature, stale signed payload, validly signed malformed JSON, own/worker echo, eligible human event;
  then three eligible events within 1.5 seconds. Replay before/after restart within the 60-second signature window; include a fresh human control. Never expose the secret.
- **Expected:** Bad/stale signatures return 401; malformed payload returns 400. Own/worker echoes cause zero accepted wakes;
  human burst yields one coalesced turn in the configured ordinary chat, not an issue's worker/owner conversation. Replays add no wake.
- **Look:** `linear.webhook` decision/delivery IDs and target's `clankie conversations show ID --limit 20` / `tail ID`; HTTP 200 alone proves nothing about turns.
- **Automation:** [signed HTTP/restart/coalescing](../../apps/clankie/test/linear-webhook.integration.test.ts), [own-write matching](../../apps/clankie/test/linear-revision-receipts-integration.test.ts); real provider attribution is manual-only.

### 9. Goal self-activation or budget escape — [VUH-1676](https://linear.app/vuhlp/issue/VUH-1676), [VUH-1686](https://linear.app/vuhlp/issue/VUH-1686)

- [ ] **Setup:** Disposable Pi-owned conversation with instrumented provider usage; separate captain and owner credentials, never printed.
- **Action:** Let the agent propose a goal; attempt activation via captain authority, then restart. Owner accepts via `clankie conversations goal ID accept`;
  separately set a small explicit budget with `clankie conversations goal ID set --tokens N "objective"`. Repeat proposal/accept with a native head.
- **Expected:** Proposal/restart never activates itself; captain activation/accept/resume/autonomy-on returns `goal_owner_required`.
  Owner acceptance activates only that goal. Accounted exhaustion stops before another provider request and survives restart; in-flight overshoot is recorded.
  Native-head service goals refuse with `native_goal_unsupported`. This is an API authority test, not same-UID OS isolation.
- **Look:** `clankie conversations goal ID`, `autonomy.json`, turn journal and provider request/usage counter, including failed/retried calls.
- **Automation:** [activation authority](../../apps/clankie/test/goal-activation-authority.integration.test.ts), [budget execution](../../apps/clankie/test/goal-execution-integration.test.ts), [native refusal](../../apps/clankie/test/native-goal-refusal.integration.test.ts); paid-provider accounting is manual-only.

### 10. Support grant expires or is revoked — [VUH-1367](https://linear.app/vuhlp/issue/VUH-1367)

- [ ] **Setup:** Existing disposable hosted tenant with customer-issued, narrowly scoped, short-lived support grant UI/API; otherwise mark **unavailable**.
- **Action:** Try access before granting, within scope, outside scope and on another tenant; open a support channel, then expire/revoke the grant.
- **Expected:** Only the granted customer/scope/time admits access with a visible audit ID. Expiry/revocation stops the next request and active channel; no inherited tenant access.
- **Look:** Customer-visible grant state, private hosted authorization/audit logs and a fresh post-revocation request, not merely SSM `Online` status.
- **Automation:** **Manual-only / implementation gap at this base.** No public customer-grant test; worker MCP grants and IAM-profile swaps do not prove this boundary. Keep tenant evidence in clankie-ops.

### 11. Hosted connection token escapes the body — [VUH-1383](https://linear.app/vuhlp/issue/VUH-1383), [VUH-1369](https://linear.app/vuhlp/issue/VUH-1369)

- [ ] **Setup:** Disposable hosted body and synthetic provider with a secret canary; existing authorized device/owner flow, no new account sign-in.
- **Action:** Connect, exercise token-echoing errors/refresh, inspect account status, then disconnect with provider unavailable; repeat from an insufficient/revoked device.
- **Expected:** Tokens stay in the body's broker; PKCE verifier stays in its pending in-memory flow. Client sees metadata, gateway sees encrypted code/state; no canary in client/log/event/telemetry output.
  Unauthorized device is refused; disconnect deletes local custody even if remote revocation fails. Do not claim provider revocation without its receipt.
- **Look:** Broker presence without printing secrets, `/v1/accounts` responses, encrypted gateway capture and redacted body/client telemetry.
- **Automation:** [accounts/redaction](../../apps/clankie/test/accounts.test.ts), [gateway encryption](../../apps/clankie/test/gateway-encryption.test.ts), [fixture proof and limits](2026-09-26-hosted-connections/README.md); real hosted/provider/device custody is manual-only.

### 12. Deploy happens during a live voice session — [VUH-1522](https://linear.app/vuhlp/issue/VUH-1522), [VUH-1472](https://linear.app/vuhlp/issue/VUH-1472)

- [ ] **Setup:** Consenting test call, marked handoff, clean running pin and existing approved local update ref. Record `clankie discord call`;
      set `clankie integrate hold --holder James --reason "VUH-1522 live voice"`.
- **Action:** Attempt an update while held. When James permits interruption, run `clankie integrate release HOLD_ID --actor James --reason "voice test finished"`,
  run `clankie update --ref APPROVED_BRANCH_OR_SHA` and make a fresh attributed ask. Named branches fetch origin; explicit SHAs remain exact. Inspect the accepted SHA and any older/diverged warning.
- **Expected:** Hold blocks admission with unchanged runtime/call. After release, terminal receipts identify the new boot SHA; one active mouth/body and an audible fresh ask/result.
  Record original handoffs as completed/interrupted/unconfirmed; stale-session results may be dropped. Never replay them automatically.
  Record disconnect/rejoin and audio gaps; active voice creates no automatic hold here. Accepted/pending is not recovery or proof of uninterrupted audio.
- **Look:** `clankie integrate holds`, `clankie update status`, `clankie status`, `clankie discord call`, service boot receipts and actual listeners' observations.
- **Automation:** [hold admission](../../apps/clankie/test/integrate.integration.test.ts) is partial; live deployment, continuity and audibility are **manual-only**.

### 13. Full gate/push applies to the exact HEAD — [VUH-1522](https://linear.app/vuhlp/issue/VUH-1522)

- [ ] **Setup:** Integrator-owned approved inputs. Negative cases require an isolated service/fixture `IntegrationQueue` bound to private clone sources, HOME/state/credentials and bare origins;
      changing the caller's directory does not retarget the service. Follow [integration admission](../integration.md); no evals.
- **Action:** `clankie integrate CORE_SHA --id UUID --no-wait` (add approved `--app APP_SHA` when needed), poll `clankie integrate status UUID`,
  then `clankie integrate push UUID` only after a recorded pass. Separately alter gated HEAD or dirty its tree in the fixture before push.
- **Expected:** Every required gate exits zero on the exact composed SHA and clean tree; matching origin/destination permit a fast-forward only.
  Failed/missing gates, changed HEAD or dirty tree refuse landing. Gate output for another SHA cannot authorize this push; push does not deploy.
- **Look:** Returned `batch.evidence` path (default `~/.clankie/integration/batches/UUID/record.json`, under `CLANKIE_STATE` when set), gate logs/exits/tested SHAs and `git ls-remote origin refs/heads/main`.
- **Automation:** [real Git/private-install fixtures](../../apps/clankie/test/integrate.integration.test.ts) use a fixture gate; the actual full release/batch gate remains an explicit integrator run, **manual-only** here.

### 14. Origin moves while a gate is running — [VUH-1522](https://linear.app/vuhlp/issue/VUH-1522)

- [ ] **Setup:** Isolated service/fixture queue bound to two private clones/origin at A and private state/credentials. Install a gate barrier before composition;
      without this fixture mark unavailable. Compose and wait at the barrier; never edit a tree while its gate runs.
- **Action:** Advance that private origin to B from the second clone, release the gate and attempt landing. Start a fresh batch from B with the approved inputs.
- **Expected:** Old batch is held for origin drift and leaves origin at B; no force-push or stale attestation reuse. Fresh composition reruns its gate.
- **Look:** Both batch IDs, base/composed/tested/origin SHAs, gate logs and independent `git ls-remote`; reconcile any uncertain push before doing anything else.
- **Automation:** [saved-pass drift refusal](../../apps/clankie/test/integrate.integration.test.ts) moves origin after the gate; the during-gate timing is **manual-only / coverage gap**.

### 15. Seat call loses its response during service restart — [VUH-1638](https://linear.app/vuhlp/issue/VUH-1638)

- [ ] **Setup:** One test seat and controlled upstream link; preserve the owning conversation and original `deliveryId` or `hireId`.
- **Action:** Admit one marked `message_seat` or hire, cut the response link, restart the test service, reconnect and call
  `reconcile_seat_call({deliveryId: ORIGINAL})` or `reconcile_seat_call({hireId: ORIGINAL})`. Do not issue a replacement call.
- **Expected:** Original receipt or explicit unresolved state survives; independently observed effect occurs once. Wrong conversation/lane refuses;
  replacement occupants gain no control/replay authority. Original owning conversation may still read its historical receipt.
- **Look:** Receipt journal, bridge generation, native transcript/census and original effect IDs; a receipt marked stored is not proof that the worker completed the task.
- **Automation:** [HTTP/stdio receipt persistence](../../apps/clankie/test/mcp-receipts-integration.test.ts), [bridge receipts](../../apps/tui/test/mcp-bridge.test.ts); live native restart remains manual-only.

## Additional retained checks

These older checks use the same setup/action/observation discipline; none is an automatic release requirement.

- [ ] **Private descriptor isolation — [VUH-1631](https://linear.app/vuhlp/issue/VUH-1631):** In a disposable HOME, hash the baseline `~/.clankie/links/default-local.json`;
      boot/close/fail a second service with private `CLANKIE_STATE`. Baseline bytes/route stay unchanged; missing private descriptor refuses fallback.
      Look at hashes/route identity, never credentials. [Discovery coverage](../../apps/tui/test/worker-link.test.ts) is partial; live lifecycle is manual-only.
- [ ] **Voice interruption — [VUH-1522](https://linear.app/vuhlp/issue/VUH-1522):** In the test call, interrupt Clankie's speech while a marked worker task runs.
      Speech stops while the worker's own receipt/progress continues, without cancellation or redispatch. Look at audio, task transcript and receipt; **manual-only**.
- [ ] **Shared dependency writes — [VUH-1522](https://linear.app/vuhlp/issue/VUH-1522):** Before an isolated install/build, resolve dependency/cache symlinks and hash selected shared files.
      No target may enter a shared checkout; afterward hashes stay unchanged. Inspect `.pnpm`, `.bin`, `.vite` and Skia `libs/macos` when present; **manual-only**.
      Never create a forbidden shared link to reproduce the incident; the historical deletion operation is unproven.

## Run record

Keep dated, redacted evidence in `docs/testing/YYYY-MM-DD-trust-delivery/`: case, `pass` / `fail` / `unavailable`, exact setup/action,
revisions, UTC times, original IDs, expected vs observed result and artifact paths. Keep private app/tenant evidence in its owning repo.
Link failures to the existing issue above; new failures belong under VUH-1522. Record missing native, provider, device or attribution proof as an open gap.
