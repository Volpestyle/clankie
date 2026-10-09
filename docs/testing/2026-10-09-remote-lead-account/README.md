# Explicit remote lead Claude account — VUH-1982

[VUH-1982](https://linear.app/vuhlp/issue/VUH-1982) adds an optional `account`
label to remote project-lead launch. The target resolves it to its existing
`~/.claude-<label>`, ahead of the SSH `CLAUDE_CONFIG_DIR`, and requires native
Claude.ai sign-in. Omitting the label keeps environment selection or the
exactly-one-signed-in-profile behavior.

## Focused verification

On 2026-10-09, this command exited 0: **2 files, 4 tests passed**.

```sh
clankie heavy -- pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/remote-lead-http.integration.test.ts \
  apps/clankie/test/remote-project-leads.integration.test.ts
```

The real launch HTTP route refuses unauthenticated requests and unsafe account
labels before remote transport. A valid label reaches the private launch frame.
Reusing a request ID with another account refuses rather than changing intent.

The real setup consumer runs against temporary profile directories and a
fixture native Claude executable. With two signed-in profiles and the SSH
default pointing at the other account, only the requested profile receives auth
and plugin commands. Missing, logged-out, API-key-only, malformed-auth and failed
auth selections refuse before plugin/policy changes. Unsafe labels invoke no
native command. Existing credential bytes and the other profile are preserved;
no missing profile is created. Omitted-account environment selection, ambiguous
selection refusal and single-profile automatic selection also pass.

The existing private TCP handoff, standalone bridge build, stdio MCP and HTTP
delegation checks pass alongside the account checks. Host identity, SSH and
Claude auth are fixtures; this is integration evidence at the trust boundary,
not acceptance of a deployed Windows head or proof of a real account's login.

## Landing evidence and remaining live work

The issue's result attachment/comment retains the checked revision, fetched
base, root landing-gate exit status and logs. The initial verified source was
`2c4f1f17b0a4a9c4db613e9039949162644791ca`; landing rebases onto current
`origin/main` and checks that result through `clankie heavy`.

No PC connection, account setup, live launch, lane steering or runtime deployment
was performed. The owner signs the intended profile in on the PC; Clankie owns
the live KH2 relaunch and native tool/channel verification afterward. Use
`"account": "volpestyle"` in that separate launch request.
