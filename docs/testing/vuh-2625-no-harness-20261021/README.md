# VUH-2625: a first hire with no harness installed names the real next step

Captured on 2026-10-21 on scratch services (`scripts/scratch-stack.mjs`: private
HOME, state, settings and credentials, Herdr disabled). Each service was started
with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, so it had no `node`, `claude` or
`codex` on PATH. That matches a release on a fresh Mac, which runs on its own
`libexec/node`. James's service was not touched.

The script below reads the service's real `GET /v1/worker-accounts`, then
renders what a hire with no harness named refuses with (`chooseWorkerHarness`)
and what `/setup` says after the hire request (`noHarnessReady`). The before
run imported the same functions from a d5ee10a80 worktree and quoted that
version's fixed `/setup` text.

```ts
// Reads the scratch service's real worker-accounts report and renders what a hire and /setup say from it.
// Saved in this directory, run from the checkout: node --import ./scripts/dependency-types.mjs FILE SCRATCH/stack.env
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { chooseWorkerHarness } from "../../../apps/clankie/src/captain/harness-accounts.ts";
import { noHarnessReady } from "../../../apps/tui/src/setup-commands.ts";
const env = parseEnv(readFileSync(process.argv[2]!, "utf8"));
const response = await fetch(`${env.CLANKIE_CONTROL_PLANE_URL}/v1/worker-accounts`, {
  headers: { authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}` },
});
const report = await response.json();
console.log(
  JSON.stringify(
    {
      status: response.status,
      unavailable: report.unavailable,
      accounts: report.accounts.map((a: any) => ({
        harness: a.harness,
        label: a.label,
        usable: a.usable,
        reason: a.reason,
      })),
    },
    null,
    2,
  ),
);
console.log("\nhire (no harness named):", JSON.stringify(chooseWorkerHarness("local", report)));
console.log("\n/setup after the hire request:", noHarnessReady(report));
```

## Before (`before-d5ee10a80.txt`)

- **Claude and Codex:** "local did not answer the account probe (is Node on
  its PATH and the machine linked?)". The probe is `node -e …` through
  `/bin/sh`, and this Mac had no `node`, so it never ran.
- **Pi:** "Native Pi control is not enabled", with no remedy.
- **The hire refusal named only Pi.** Once any account was skipped, the
  `unavailable` reasons were dropped.
- **`/setup`:** "No live agent seat is observed yet".

## After (`after.txt`)

- **Claude and Codex:** this Mac's probe falls back to the service's own Node.
  It reports each harness with no command on PATH as not installed, with its
  install command, sign-in and `clankie harness install`. A linked machine names
  `clankie herdr prepare NAME` instead.
- **Pi:** names the opt-in: `CLANKIE_PI_NATIVE_ENABLED=1` in the service's
  environment plus a restart (`CLANKIE_PI_NATIVE_ENABLED=1 clankie restart`).
  No setting or other command enables it.
- **The hire refusal** lists all three reasons.
- **`/setup`** says that no agent harness on this Mac can take the hire yet, and
  repeats the same reasons.

The install commands are the vendors' published ones. They were not run here.
