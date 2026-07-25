import { createHash } from "node:crypto";
import { createDefaultCredentialStore } from "@clankie/credential-broker";
import { OpenAiVoiceSpeechRuntime } from "@clankie/discord-presence-core";

const store = createDefaultCredentialStore();
const credential = await store.get("openai");
if (process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY must not be set; the live proof uses the brokered openai credential");
}
if (credential?.type !== "api") {
  throw new Error("The brokered openai API credential is unavailable");
}

const speech = new OpenAiVoiceSpeechRuntime({
  apiKey: credential.key,
  ...(process.env.CLANKIE_VOICE_STT_MODEL === undefined
    ? {}
    : { sttModel: process.env.CLANKIE_VOICE_STT_MODEL }),
  ...(process.env.CLANKIE_VOICE_TTS_MODEL === undefined
    ? {}
    : { ttsModel: process.env.CLANKIE_VOICE_TTS_MODEL }),
  ...(process.env.CLANKIE_VOICE_TTS_VOICE === undefined
    ? {}
    : { voice: process.env.CLANKIE_VOICE_TTS_VOICE }),
});
const transcript = await speech.transcribe(Buffer.alloc(16_000 * 2));
const audio = await speech.synthesize("Clankie voice transport test.");
const report = {
  schemaVersion: 1,
  passed: true,
  provider: "openai",
  transcriptionRequestSettled: true,
  transcriptCharacters: transcript?.length ?? 0,
  ttsBytes: audio.pcm24KhzMono.byteLength,
  ttsSha256: createHash("sha256").update(audio.pcm24KhzMono).digest("hex"),
};
audio.pcm24KhzMono.fill(0);
process.stdout.write(`${JSON.stringify(report, null, process.argv.includes("--json") ? 2 : 0)}\n`);
