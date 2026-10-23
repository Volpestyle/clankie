# Free account routing (VUH-2711)

Source base: fetched `origin/main` `af52d4aa1` (2026-10-23). Local evidence;
no production, AWS or Stripe calls.

`clankie heavy -- pnpm exec vitest run apps/tui/test/hosted-login-routing.test.ts`
passed **9/9**. A tenant-less account signs this Mac in for remote access;
explicit `connect hosted` refuses without a hosted machine. Existing hosted
accounts still route to their existing body. Core has no Checkout/provisioning
endpoint; the fleet's default-closed sales and first-tenant materialization
gates live in clankie-ops (VUH-2711-ops).

The no-hosted-machine error now directs the owner to `clankie login` and states
that hosted machines are no longer sold, removing its stale purchase suggestion.
