# Harness account identity discovery — VUH-2145

Candidate fix for [VUH-2145](https://linear.app/vuhlp/issue/VUH-2145/harness-accounts-are-identified-by-the-signed-in-account-discovered).

The scratch HOME contains, for each harness, two homes signed into identity A
and one into B. A manual override also points at the default home. Fake native
executables implement the non-secret Claude `auth status` and Codex
`account/read` contracts; Codex rejects identity reads without
`refreshToken:false`. Discovery, persistence, API routes, schema parsing, CLI
commands and hire refusal use the real implementation. No real-home identity
queries, sign-in/out, live-service restart or remote-pane operations were performed.

| Result per harness             | Baseline `9de66a3e0` | Fix |
| ------------------------------ | -------------------: | --: |
| Account rows/cards             |                    4 |   2 |
| Identity queries per discovery |                    4 |   3 |
| Identifiable accounts          |                    2 |   2 |

Across both harnesses: **8 rows → 4**, **8 identity queries → 6**. These are
measured scratch counts, not a claim about live request rates. The baseline's
original probe executes in the same fake HOME. The extra query is the implicit
and registered default home being queried twice; the extra rows also include
two different homes belonging to one identity.

The acceptance proof checks:

- Canonical-home deduplication before native identity reads and one stable key
  per identity, shared by API, CLI account lists and usage.
- One limit pool per identity; a different home cannot evade an exhausted pool.
- A → B re-sign keeps A's preferences/holds and cached usage with A. The old
  folder alias continues selecting A's remaining home.
- A delayed older native read cannot invent a reverse re-sign. One actual
  re-sign produces one notice, retained across registry reload.
- An absent identity, or a home with unavailable native identity, cannot satisfy
  the old alias. The hire refuses before a pane exists.
- Remote-lead preparation checks the expected non-secret identity against the
  chosen home before setup and again before launch.
- App usage and Settings consume the same recorded API responses through real
  HTTP and the owner client. Four cards retain their keys across the re-sign;
  the headings show signed-in emails.

Reproduce from the core repository root:

```sh
mkdir -p .local/vuh2145/evidence
git show 9de66a3e054958474f2ccae133719f9bede9f07f:apps/clankie/src/captain/harness-accounts.ts > .local/vuh2145/baseline-source.ts
VUH2145_EVIDENCE_DIRECTORY="$PWD/.local/vuh2145/evidence" \
VUH2145_BASELINE_SOURCE="$PWD/.local/vuh2145/baseline-source.ts" \
clankie heavy -- pnpm exec vitest run apps/clankie/test/harness-account-identities.integration.test.ts apps/clankie/test/worker-accounts.integration.test.ts
```

The app's focused proof is
`packages/command-center/src/settings/HarnessAccountIdentities.integration.test.tsx`.
Its golden responses come from this core proof; only the temporary HOME prefix
is normalized. Core/app worktrees use a real sibling layout. The app's full
`clankie heavy -- pnpm check` passed with the isolated `clankie-ops` fixture
checkout at `a0dddfa`.

Live identity discovery and native Windows execution remain unmeasured here.
Deployment and issue closure belong to the lead.
