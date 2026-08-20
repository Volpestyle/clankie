import { isDiscordBodyActive } from "@clankie/settings";
import type { VoxProcessStatus } from "@clankie/vox-client";

export function assertOfficialBotBodyActive(env: NodeJS.ProcessEnv): void {
  if (!isDiscordBodyActive("bot", env)) {
    throw new Error(
      "discord_bot_inactive_body: Set DISCORD_ACTIVE_BODY=bot before starting the official bot bridge directly",
    );
  }
}

export function discordBridgeHealth(input: {
  readonly discordReady: boolean;
  readonly shuttingDown: boolean;
  readonly terminalFailure?: string;
  readonly voiceEnabled: boolean;
  readonly vox?: { readonly status: VoxProcessStatus; readonly detail: string };
}): {
  readonly ok: boolean;
  readonly service: "discord-bridge";
  readonly discord: { readonly ready: boolean; readonly terminalFailure?: string };
  readonly voxProcess: "disabled" | { readonly status: VoxProcessStatus; readonly detail: string };
} {
  const voxReady = !input.voiceEnabled || input.vox?.status === "ready";
  return {
    ok: !input.shuttingDown && input.discordReady && input.terminalFailure === undefined && voxReady,
    service: "discord-bridge",
    discord: {
      ready: input.discordReady,
      ...(input.terminalFailure === undefined ? {} : { terminalFailure: input.terminalFailure }),
    },
    voxProcess: input.voiceEnabled
      ? { status: input.vox?.status ?? "missing", detail: input.vox?.detail ?? "Vox process is missing" }
      : "disabled",
  };
}
