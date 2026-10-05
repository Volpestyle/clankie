/**
 * `/minecraft` as a modal: where he is now, then join, pause, resume, chat,
 * follow or leave. Same command client as `clankie minecraft`; server hosting
 * and profile setup stay on their subcommands.
 */
import { MinecraftServerProfileSchema, MinecraftStatusSchema } from "@clankie/protocol";
import { selectMinecraftDriver } from "./minecraft-driver-menu.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

type Run = (args: readonly string[]) => Promise<Record<string, unknown>>;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runMinecraftMenu(shell: ClankieFaceShell, minecraft: Run): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("minecraft");
  try {
    for (;;) {
      const [status, listed] = await Promise.all([minecraft(["status"]), minecraft(["profiles"])]);
      const { session, actions } = MinecraftStatusSchema.parse(status);
      const profiles = MinecraftServerProfileSchema.array().parse(listed.profiles ?? []);
      const where = session && session.phase !== "disconnected" ? session : undefined;
      const world = profiles.find((profile) => profile.id === where?.profileId)?.name ?? where?.profileId;
      const running = actions.filter((action) => action.state === "running");
      const choice = await flow.readSelect({
        message: where
          ? `Minecraft · ${world} · ${where.phase}${running.length ? ` · ${running.length} running` : ""}`
          : profiles.length
            ? "Minecraft · not in a world"
            : "Minecraft · no servers yet (clankie minecraft configure PROFILE HOST --version V)",
        options: where
          ? [
              where.phase === "paused"
                ? { value: "resume", label: "Resume" }
                : { value: "pause", label: "Pause", hint: "stays connected" },
              { value: "driver", label: "Choose driver…", hint: "play mind, owner or native worker" },
              { value: "chat", label: "Say something…", hint: "owner driver" },
              { value: "follow", label: "Follow a player…", hint: "owner driver" },
              ...(running.length ? [{ value: "cancel", label: "Cancel running actions" }] : []),
              { value: "leave", label: "Leave", hint: `disconnect from ${world}` },
            ]
          : profiles.map((profile) => ({
              value: `join:${profile.id}`,
              label: `Join ${profile.name}`,
              hint: profile.id,
            })),
        allowBack: true,
      });
      if (choice === undefined) return;
      try {
        if (choice.startsWith("join:")) await minecraft(["join", choice.slice(5)]);
        else if (choice === "driver") {
          await selectMinecraftDriver(flow, minecraft);
          continue;
        } else if (choice === "chat") {
          const text = await flow.readText({ message: "Chat", allowBack: true });
          if (!text?.trim()) continue;
          await minecraft(["chat", text.trim()]);
        } else if (choice === "follow") {
          const player = await flow.readText({ message: "Player name", allowBack: true });
          if (!player?.trim()) continue;
          await minecraft(["follow", player.trim()]);
        } else await minecraft([choice]);
        flow.renderLine(choice.startsWith("join:") ? "Joining…" : `${choice} sent.`, "success");
      } catch (error) {
        flow.renderLine(message(error), "error");
      }
    }
  } catch (error) {
    shell.insertCommandResult("/minecraft", message(error), "error");
  } finally {
    flow.end();
  }
}
