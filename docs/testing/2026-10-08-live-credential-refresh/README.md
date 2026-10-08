# VUH-1807: live credential recovery evidence

Read-only inspection on 2026-10-08. No credential was printed, altered or deliberately rejected; no paid probe, service restart or deployment was performed.

## Live evidence

The running pinned checkout was `cd7e50cf523c79b6f7eeed39fbcc66a67514b89e`, containing owner-turn recovery commit `f646c5d02b771cf42761729a82292765e46804e0` (2026-10-07T22:51:36Z). Doctor sampled at 2026-10-08T08:50:23.471Z reported healthy service operation with `openai-codex/gpt-6.1-sol`, without a current credential rejection. The credential-health file was absent.

The retained service log covered 2026-08-15 through 2026-10-08T08:49:30.510Z. It contained no structured credential-recovery event after the owner-retry commit. Existing production wiring logged rejection outcomes only for hosted service credentials; this local service had no durable recovery-result event. Current health clears after acceptance, so its absence cannot establish whether a refresh happened.

Across 52 retained Pi journals, assistant records for `openai-codex` after that commit included 19 completed replies and 34 tool-use responses, with zero error records. The first assistant record was 2026-10-07T22:57:21.844Z; completed replies ranged from 22:57:35.607Z to 2026-10-08T07:05:35.377Z. The settled-turn journal independently contained 14 completed runs using that provider and model after the commit.

The Pi journals contained 16 earlier authentication-expired errors on 2026-10-07, from 13:13:50.235Z through 16:23:05.224Z. No later authentication rejection was recorded in the inspected journals. These records prove subsequent provider acceptance, but do not prove that forced refresh caused it. No post-deployment rejection/forced-refresh/acceptance sequence was available to verify.

## Change and verification

Local and hosted service turns now retain fixed `model.credential_rejected` metadata (`providerId`, recovery `outcome`) and `model.credential_accepted` when a recorded rejection clears. Upstream error text and credentials are excluded. Logging failures cannot interrupt recovery. Retry limits, actor authority, cancellation, and hosted operator repair remain unchanged.

The existing provider-boundary integration exercises real Pi sessions, local HTTP model/OAuth endpoints, file-backed credentials, owner attachments, tools and conversation receipts. It now checks recovery-result and acceptance events, cleared health on success, retained reconnect health on failed refresh or second rejection, and the exact allowed log fields.

`clankie heavy -- pnpm exec vitest run apps/clankie/test/owner-credential-retry.integration.test.ts apps/clankie/test/credential-refresh.integration.test.ts` passed all 10 tests across both files. The landing-gate result and commit are attached to VUH-1807 after checks complete.

## Open acceptance

VUH-1807 remains open for a naturally occurring live provider rejection: inspect the fixed recovery result and subsequent provider acceptance, or a reconnect/operator-required result. Successful later replies alone do not verify forced refresh. The diagnostics change must reach the running service through its normal update process before that future sequence can be observed; this assignment does not restart the service.
