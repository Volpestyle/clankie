# VUH-1998: remote lead tool permissions

Tracks: https://linear.app/vuhlp/issue/VUH-1998

Base: fetched `origin/main` at `98de6abb98f9f18a112fc0bd2a09fc341af0599c`.

The bug remains on that base: remote launch enables the lead plugin but supplies
no tool allow rule. Maximum trust adds a bypass flag only when enabled.

The fix adds only `mcp__plugin_clankie-remote-lead_lead` to the launch's
session permissions. The integration test executes the bootstrap head with
maximum trust disabled and inspects the child process's settings arguments.
It asserts the delegated lead plugin is the only added permission.

Focused check: `clankie heavy -- pnpm exec vitest run apps/clankie/test/remote-lead-http.integration.test.ts`
passed: one file, four tests, exit 0. The concise output is retained here:

```text
RUN v4.1.10 /Users/james/dev/clankie-wt/vuh-1998
Test Files 1 passed (1)
Tests 4 passed (4)
Start at 20:23:49
Duration 45.03s (transform 2.70s, setup 25ms, import 4.14s, tests 40.74s, environment 0ms)
```

The initial attempt could not load Vitest because this fresh worktree had no
dependencies; a fleet-governed frozen install succeeded before this passing run.

This is launch/HTTP/MCP integration evidence with native-host fixtures, not a
live Windows Claude classifier result. Clankie will arrange the live auto-mode
`message_seat` check after deployment. No PC Herdr or shell was touched.
Keep the issue in Verifying until that proof is recorded.
