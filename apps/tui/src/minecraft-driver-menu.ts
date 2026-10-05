import { runMinecraftCommand } from "./command/minecraft.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

export async function runMinecraftDriverMenu(
  shell: ClankieFaceShell,
  options: Parameters<typeof runMinecraftCommand>[1],
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("Minecraft driver");
  try {
    const status = await runMinecraftCommand(["driver"], options);
    const driver = status.driver as { kind?: string; principalId?: string } | undefined;
    const current = driver?.kind;
    flow.renderLine(
      `Current driver: ${current ?? "unknown"}${driver?.principalId ? ` (${driver.principalId})` : ""}`,
    );
    const selected = await flow.readSelect({
      message: "Who drives this Minecraft session?",
      options: [
        {
          value: "mind",
          label: "Clankie's play mind",
          description: "Resume his configured autonomous play loop.",
        },
        {
          value: "owner",
          label: "Owner",
          description: "Drive through Minecraft actions in this conversation.",
        },
        {
          value: "worker",
          label: "Native worker",
          description: "Hand control to an exact hired fleet seat.",
        },
      ],
      statusActions: [{ value: "done", label: "Done" }],
      ...(current === undefined ? {} : { currentValue: current, initialValue: current }),
      allowBack: true,
    });
    if (!selected || selected === "done") return;
    let args = ["driver", selected];
    if (selected === "worker") {
      const principal = await flow.readText({
        message: "Worker principal",
        placeholder: "fleet:FLEET:pane:SEAT",
        ...(driver?.principalId === undefined ? {} : { defaultValue: driver.principalId }),
        allowBack: true,
        validate: (value) =>
          /^fleet:[a-z][a-z0-9-]*:pane:(?!unverified$)\S{1,128}$/u.test(value.trim())
            ? undefined
            : "Use the exact fleet:FLEET:pane:SEAT principal.",
      });
      if (principal === undefined) return;
      args = [...args, principal.trim()];
    }
    const result = await runMinecraftCommand(args, options);
    flow.renderLine(
      JSON.stringify(result),
      result.outcome === "refused" || result.outcome === "uncertain" ? "error" : "success",
    );
  } finally {
    flow.end();
  }
}
