import { ClankieApiClient } from "@clankie/api-client";
import { createDefaultCredentialStore, resolveDiscordUserBridgeCredential } from "@clankie/credential-broker";
import { assertUserSessionAdmissible, DiscordUserSessionRefused } from "./readiness.ts";

/**
 * Reports whether the user-session plane would be admitted, without connecting.
 * Run this before starting the plane so a refusal is diagnosed off-Discord.
 */
const store = createDefaultCredentialStore();
const bridgeToken = await resolveDiscordUserBridgeCredential({ store });
if (!bridgeToken) {
  console.error("not ready: the brokered clankie_discord_user_bridge credential is missing");
  process.exit(1);
}
const api = new ClankieApiClient({
  baseUrl: process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310",
  captainToken: bridgeToken,
});

try {
  const admission = await assertUserSessionAdmissible({
    env: process.env,
    store,
    api,
    characterId: process.env.CLANKIE_CHARACTER_ID ?? "clankie",
  });
  console.log(
    JSON.stringify(
      {
        ready: true,
        optInId: admission.optIn.optInId,
        characterId: admission.optIn.characterId,
        profileHash: admission.profileHash,
        guildIds: admission.optIn.guildIds,
        channelIds: admission.optIn.channelIds,
        dmPolicy: admission.optIn.dmPolicy,
        recordedAt: admission.optIn.recordedAt,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const code = error instanceof DiscordUserSessionRefused ? error.code : "discord_user_session_refused";
  console.error(JSON.stringify({ ready: false, code, detail: String(error) }, null, 2));
  process.exit(1);
}
