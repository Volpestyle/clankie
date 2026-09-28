# Essentials catalog and Gmail development probe

Date: 2026-09-28 UTC. Decision:
[ADR 0201](../../adr/0201-essentials-start-with-read-only-google-connections.md).
Tracking: [catalog/Gmail VUH-1430](https://linear.app/vuhlp/issue/VUH-1430),
[Calendar VUH-1431](https://linear.app/vuhlp/issue/VUH-1431),
[Drive VUH-1432](https://linear.app/vuhlp/issue/VUH-1432).

## What exists

Four original skills live in `.agents/skills`: `inbox-triage`, `daily-digest`,
`trip-planning`, `comparison-shopping`. Both Claude skill plugins link directly
to those sources. The bundle worker's root discovery supplies Pi and Codex on supported local
launches after deployment; remote fleets and existing sessions are not thereby
updated. See [ADR 0200](../../adr/0200-clankie-bundles-its-opinionated-skills.md).
This change does not modify its launch or release mechanism.

The development configuration in
[`gmail-mcp-canary.test.ts`](../../../apps/clankie/test/gmail-mcp-canary.test.ts)
uses the actual `FileCredentialStore`, `SettingsStore`, `createMcpHost` and HTTP
transport. It selects only the official Gmail endpoint, in the operator lane,
with a separate broker entry `google-gmail-canary`. Settings are ephemeral and
the canary never writes a credential. It never loads the owner's settings,
Linear connection or default Keychain. No production runtime was changed.

This is an executable development probe, **not a completed OAuth integration or
a successful live read**. The official read is
[`list_labels` with `pageSize: 1`](https://developers.google.com/workspace/gmail/api/reference/mcp/tools_list/list_labels).
Google documents it as read-only and accepting `gmail.readonly`. Labels and
tokens are not printed. A label read alone would prove authenticated transport,
not correct inbox triage; a known mail fixture remains necessary afterward.

## Reproduce

Offline regression checks (no Google network request):

```sh
pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/gmail-mcp-canary.test.ts \
  apps/clankie/test/connect-tools.test.ts \
  apps/clankie/test/mcp-host.test.ts
```

Opt-in read, only after a fresh **test-account** OAuth grant is in a private,
isolated broker file; the path is not a credential and may be supplied in the
environment. Do not point this at a customer or production broker:

```sh
CLANKIE_GMAIL_CANARY=1 \
CLANKIE_GMAIL_CANARY_CREDENTIALS_FILE=/absolute/private/test-broker/credentials.json \
pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/gmail-mcp-canary.test.ts
```

The canary requires an unexpired OAuth entry under `google-gmail-canary` and
stops with `consent_required` otherwise. An empty/missing broker is never filled
from another harness's login. This probe does not refresh Google credentials.
It suppresses provider logger payloads and asserts only safe booleans, outcomes
and nonempty response size. Do not enable HTTP debug logging during a real read.

## Observed evidence and limits

- [Focused suite](evidence/focused.txt): 24 passed, one live test skipped.
- All four skills passed the skill-creator frontmatter/name validator.
- Opting in with an absent isolated grant fails at the expected consent gate:
  [test output](evidence/consent-gate.txt). No OAuth screen was opened and no
  account read occurred. This is negative evidence, not a successful canary.
- Native mail tools were checked against their schemas and existing refusal/
  untrusted-content tests. The skills retain operator-only mail, 25-message
  maximum pages and folder+UID identity; no nonexistent draft/archive tool is
  promised. Browser names match the authored `browser_` wrapper in `tools.ts`.
- No model-driven evaluation of the four playbooks was run. Read-only browser
  research, booking and shopping outcomes must not be inferred from source review.
- [Full check](evidence/check.txt): formatting, lint, deadcode, docs, infra and
  typecheck passed. Vitest had 2886 passed, two failed, two skipped; both failures
  were in the concurrently edited `hire-brief.test.ts`. After the sibling bundle
  change, its focused rerun together with the Claude plugin tests passed (9 tests).
  The full-check invocation remains a recorded failure, not a green check.
  The remaining Vox checks ran separately: 123 Rust tests passed and IPC smoke
  exited successfully.

## Exact next step for the owner and implementer

1. The owner selects a dedicated Google test account and Cloud project with
   [Workspace Developer Preview membership](https://developers.google.com/workspace/guides/configure-mcp-servers).
   Confirm that the selected account type is eligible; consumer Gmail is not
   established by that documentation. Enable Gmail API and Gmail MCP API.
2. In Google Auth Platform, configure Branding, Audience (add the test account
   for an External testing app), and Data Access with only
   `https://www.googleapis.com/auth/gmail.readonly`. Create the OAuth client for
   the intended callback. Do not use another application's callback URL.
3. The implementer must first add Google begin/complete/refresh/revoke to the
   body-owned account path (ADR 0196), with a registered callback, state/PKCE,
   effective-scope validation, a verified account, and atomic broker lifecycle.
   There is **no working `clankie accounts connect google` command yet**.
   The current refresher and worker-account schema only support Linear.
4. Once that flow exists, the owner's exact Chrome action is: open its returned
   Google authorization URL, select the dedicated test account, review the
   read-only Gmail permission and approve, then let the registered callback
   complete on the development body. Never paste tokens into chat, a shell
   argument or this archive. Stop if the displayed account/scope is wrong.
5. Run the probe and then triage/digest a known fixture email, retaining only
   redacted results. Prove expiry, refresh, local disablement, provider revocation
   and isolation before enabling the customer catalog. For hosted distribution,
   resolve Google's restricted-scope verification/security-assessment requirements.

The missing OAuth application/consent is a real external prerequisite; the
missing body flow is remaining engineering, not something James can fix just by
clicking a consent screen. The brief explicitly permits stopping here rather
than completing that consent on his behalf.
