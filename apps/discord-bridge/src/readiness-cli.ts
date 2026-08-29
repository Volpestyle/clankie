import { ClankieApiClient } from "@clankie/api-client";
import { createDefaultCredentialStore, resolveDiscordBridgeCredential } from "@clankie/credential-broker";
import { writeCheckReport } from "@clankie/discord-presence-core";
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

writeCheckReport({
  checks: report.checks,
  json: process.argv.includes("--json"),
  jsonPayload: report,
  title: "Discord text readiness",
  outcome: report.ready ? "READY" : "NOT READY",
});

if (!report.ready) process.exitCode = 1;
