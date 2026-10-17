# VUH-2208 remote worker report recheck

Tracks: https://linear.app/vuhlp/issue/VUH-2208

Source base: `cc2eb50e57c28b89f3979adf68d3965fb8615989` (fetched `origin/main`).
Run: 2026-10-17 04:08–04:10 UTC; Lark, overnight recheck.

## Result

The recorded `binding_unavailable` cause is already fixed by `353942dc95f97c1f7870f30abe7bb003dac60beb`, present on current main. The issue's Oct 14 investigation correlates Pip's 04:11:14Z failure with `remote_observation_timeout`. Remote pane proof failed before forwarding, but its bare HTTP 503 did not identify the retryable pre-forward admission refusal. The fix returns `fleet_admission_unavailable`, retaining the observation code, so installed bridges retry once.

The existing regression now also covers proof timing out during POST admission, after a successful binding GET. Both cases traverse the real Codex-parent worker bridge, process-authenticated link, HTTP seat routes and inbound conversation receipt store. Remote proof and the captain port are fixtures; this is a local fake-remote proof, not a live Windows or native-lead proof. Each report returns `stored`, enters the conversation with the original text, and invokes acceptance exactly once.

- **Current code:** `clankie heavy -- pnpm exec vitest run apps/clankie/test/remote-worker-report-admission.integration.test.ts apps/clankie/test/fleet-report-reasons.integration.test.ts` — exit 0, 3/3 tests.
- **Without the existing fix:** temporarily replaced only the retryable refusal with the original bare 503 in this isolated worktree, then restored the file byte-for-byte. Both report cases fail: binding lookup returns `unavailable`; POST admission returns `uncertain`. Exit 1, 2/2 failed. This proves the regression detects the recorded cause rather than merely passing a happy path.
- No product fix was duplicated. No PC lane was started, stopped or typed into; no shared service restart, deploy or release occurred.

## Watch history and daytime gap

The issue history records that no completion watch was armed for Pip's 05:19Z plain reply. Six later explicit KH2 watches appear in the delivered head journal. `cc281e21e` separately landed watch settlement improvements. This recheck does not claim a fresh live watch result.

The read-only `clankie runtime list` snapshot shows `pc` healthy/ready and the separate `kh2` runtime unreachable. Transport health does not establish report delivery.

Daytime still needs an authorized running KH2 lead plus one PC Codex worker: call `message_clankie`, retain its stored receipt and lead receipt, deploy/restart under daytime authority, then repeat with a distinct report and retain both sides. Verify an explicitly armed completion watch if reconfirming that criterion. Leave VUH-2208 In Progress pending this proof, as directed by the lead.

Raw logs and runtime snapshot are retained in the evidence store (`evidence.json`). The landing gate receipt is in the worktree's `.local/landing-gate.json`; its checked HEAD/base and outcome are posted on the issue after landing.
