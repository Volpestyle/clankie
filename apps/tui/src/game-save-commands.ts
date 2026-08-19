import {
  defaultGbaCheckpointDir,
  deleteGbaCheckpoint,
  listGbaCheckpoints,
  type GbaCheckpointReceipt,
} from "@clankie/gba-emulator/checkpoint";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export function buildGameSaveCommands(options: { rootDir?: string } = {}): FaceShellCommand[] {
  return [
    {
      name: "saves",
      aliases: ["checkpoints"],
      description: "Browse or delete Clankie's local Pokémon saves",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        await browseGameSaves(shell, options.rootDir ?? defaultGbaCheckpointDir());
      },
    },
  ];
}

async function browseGameSaves(shell: ClankieFaceShell, rootDir: string): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("saves");
  try {
    for (;;) {
      const saves = listGbaCheckpoints(rootDir);
      if (saves.length === 0) {
        flow.renderLine("No local Pokémon saves exist.", "info");
        return;
      }
      const picked = await flow.readSelect({
        kind: "single",
        message: "Local Pokémon saves\nHosted-world saves stay with their world server.",
        options: saves.map(saveOption),
        statusActions: [{ value: "done", label: "Done" }],
        required: true,
      });
      const checkpointId = picked?.[0];
      if (checkpointId === undefined || checkpointId === "done") return;
      const save = saves.find((candidate) => candidate.checkpointId === checkpointId);
      if (save === undefined) continue;

      const action = await flow.readSelect({
        kind: "single",
        message: saveDetails(save),
        options: [
          { value: "back", label: "Back", description: "Keep this save." },
          { value: "delete", label: "Delete", description: "Permanently remove this checkpoint." },
        ],
        initialValue: "back",
        required: true,
        allowBack: true,
      });
      if (action?.[0] !== "delete") continue;

      const confirmation = await flow.readSelect({
        kind: "single",
        message: `Delete ${saveName(save)}? This cannot be undone.`,
        options: [
          { value: "cancel", label: "Cancel" },
          { value: "delete", label: "Delete permanently" },
        ],
        initialValue: "cancel",
        required: true,
        allowBack: true,
      });
      if (confirmation?.[0] !== "delete") continue;
      try {
        deleteGbaCheckpoint({ rootDir, checkpointId });
        flow.renderLine(`Deleted ${saveName(save)}.`, "success");
      } catch (error) {
        flow.renderLine(error instanceof Error ? error.message : String(error), "error");
      }
    }
  } finally {
    flow.end();
  }
}

function saveOption(save: GbaCheckpointReceipt) {
  return {
    value: save.checkpointId,
    label: saveName(save),
    hint: save.capturedAt,
    description:
      save.position === null
        ? save.checkpointId
        : `${save.position.mapId} (${String(save.position.x)},${String(save.position.y)}) · ${save.checkpointId}`,
  };
}

function saveName(save: GbaCheckpointReceipt): string {
  const game =
    save.environmentId === "pokemon-firered"
      ? "FireRed"
      : save.environmentId === "pokemon-emerald"
        ? "Emerald"
        : `ROM ${save.romSha256.slice(0, 8)}`;
  return `${game} · ${save.label ?? "checkpoint"}`;
}

function saveDetails(save: GbaCheckpointReceipt): string {
  const position =
    save.position === null
      ? "unknown"
      : `${save.position.mapId} (${String(save.position.x)},${String(save.position.y)})`;
  return [
    saveName(save),
    `Captured: ${save.capturedAt}`,
    `Position: ${position}`,
    `ID: ${save.checkpointId}`,
  ].join("\n");
}
