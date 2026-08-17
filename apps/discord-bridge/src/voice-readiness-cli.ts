import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  resolveDiscordVoiceBridgeCredential,
} from "@clankie/credential-broker";
import { inspectDiscordVoiceReadiness } from "./voice-readiness.ts";
import {
  applyDiscordSettingsToEnvironment,
  applyVoiceSettingsToEnvironment,
  SettingsStore,
} from "@clankie/settings";

// Readiness must inspect the configuration the bridge will actually run with.
// The bridge fills unset DISCORD_* names from the operator settings file at
// startup, so a checker reading bare environment would report failures for a
// deployment that is in fact configured — the exact opposite of its job.
const storedSettings = await new SettingsStore().load();
applyDiscordSettingsToEnvironment(storedSettings.discord);
applyVoiceSettingsToEnvironment(storedSettings.voice);

const store = createDefaultCredentialStore();
const bridgeToken = await resolveDiscordVoiceBridgeCredential({ store });
const api = new ClankieApiClient({
  baseUrl: process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310",
  ...(bridgeToken === undefined ? {} : { captainToken: bridgeToken }),
});
// This is the live path: with no injected wakeProbe, readiness builds the real
// dormant→engaged probe from the brokered openai credential and opens both
// realtime session tiers in sequence (skipped as failed checks when the
// selected realtime-provider credential and opens both session tiers in
// sequence (skipped as failed checks when the credential or configuration is
// missing). Unit tests inject fakes instead.
const report = await inspectDiscordVoiceReadiness({
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
  process.stdout.write(`\nDiscord group voice readiness: ${report.ready ? "READY" : "NOT READY"}\n`);
}
if (!report.ready) process.exitCode = 1;
