import { ClankieApiClient } from "@clankie/api-client";
import { createDefaultCredentialStore, resolveDiscordBridgeCredential } from "@clankie/credential-broker";
import { inspectDiscordTextReadiness } from "./readiness.ts";

const store = createDefaultCredentialStore();
const bridgeToken = await resolveDiscordBridgeCredential({ store });
const api = new ClankieApiClient({
  baseUrl: process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310",
  ...(bridgeToken === undefined ? {} : { captainToken: bridgeToken }),
});
const report = await inspectDiscordTextReadiness({
  env: process.env,
  store,
  api,
});

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const width = Math.max(...report.checks.map((check) => check.name.length));
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}\n`);
    if (!check.ok && check.remediation) {
      process.stdout.write(`      ${"".padEnd(width)}  ${check.remediation}\n`);
    }
  }
  process.stdout.write(`\nDiscord text readiness: ${report.ready ? "READY" : "NOT READY"}\n`);
}

if (!report.ready) process.exitCode = 1;
