import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  resolveDiscordVoiceBridgeCredential,
} from "@clankie/credential-broker";
import { inspectDiscordVoiceReadiness } from "./voice-readiness.ts";
import { OpenAiVoiceSpeechRuntime, type VoiceSpeechRuntime } from "@clankie/discord-presence-core";

const store = createDefaultCredentialStore();
const bridgeToken = await resolveDiscordVoiceBridgeCredential({ store });
const api = new ClankieApiClient({
  baseUrl: process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310",
  ...(bridgeToken === undefined ? {} : { captainToken: bridgeToken }),
});
const openAiCredential = await store.get("openai");
const speech: VoiceSpeechRuntime =
  openAiCredential?.type === "api"
    ? new OpenAiVoiceSpeechRuntime({
        apiKey: openAiCredential.key,
        ...(process.env.CLANKIE_VOICE_STT_MODEL === undefined
          ? {}
          : { sttModel: process.env.CLANKIE_VOICE_STT_MODEL }),
        ...(process.env.CLANKIE_VOICE_TTS_MODEL === undefined
          ? {}
          : { ttsModel: process.env.CLANKIE_VOICE_TTS_MODEL }),
        ...(process.env.CLANKIE_VOICE_TTS_VOICE === undefined
          ? {}
          : { voice: process.env.CLANKIE_VOICE_TTS_VOICE }),
      })
    : {
        readiness: () =>
          Promise.resolve({
            ready: false,
            provider: "openai",
            sttModel: process.env.CLANKIE_VOICE_STT_MODEL ?? "gpt-4o-mini-transcribe",
            ttsModel: process.env.CLANKIE_VOICE_TTS_MODEL ?? "gpt-4o-mini-tts",
            voice: process.env.CLANKIE_VOICE_TTS_VOICE ?? "marin",
            responseFormat: "pcm",
          }),
        transcribe: () => Promise.reject(new Error("OpenAI speech credential is unavailable")),
        synthesize: () => Promise.reject(new Error("OpenAI speech credential is unavailable")),
      };
const report = await inspectDiscordVoiceReadiness({
  env: process.env,
  store,
  api,
  speech,
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
