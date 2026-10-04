import {
  DiscordSetupClient,
  discordSetupPickers,
  discordSetupLabel,
  discordPickerIds,
  discordPickerEntries,
  discordDirectoryEntryLabel,
  type DiscordSetupApi,
  type DiscordSetupView,
  type DiscordPickerSelection,
  type DiscordSetupPicker,
  type DiscordAccessChoice,
} from "@clankie/api-client";
import { stripVTControlCharacters } from "node:util";
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { SetupFlow } from "./shell/setup-flow.ts";

const plain = (text: string) => stripVTControlCharacters(text).replace(/[\r\n\t]/gu, " ");
function formatDiscordSetup(view: DiscordSetupView): string {
  return view.sentences
    .map(
      (sentence) =>
        `${plain(sentence.text)}\n${sentence.checks.map((check) => `${check.status === "passed" ? "✓" : "not checked"} ${plain(check.label)}`).join(" · ")}`,
    )
    .join("\n\n");
}
export async function showDiscordSetup(shell: ClankieFaceShell, api: DiscordSetupApi) {
  shell.insertCommandResult(
    "/discord",
    formatDiscordSetup(await new DiscordSetupClient(api).read()),
    "success",
  );
}
async function pickMultiple(
  flow: SetupFlow,
  view: DiscordSetupView,
  part: DiscordSetupPicker,
  message: string,
  access?: DiscordAccessChoice,
): Promise<string[] | undefined> {
  const choices = discordPickerEntries(view, part, access);
  if (!choices.length) {
    flow.renderLine("No choices are available from his connected Discord account.", "warning");
    return undefined;
  }
  const selected = new Set(
    discordPickerIds(view.snapshot, part).filter((id) => choices.some((entry) => entry.id === id)),
  );
  for (;;) {
    const choice = await flow.readSelect({
      message,
      allowBack: true,
      options: [
        ...choices.map((entry) => ({
          value: entry.id,
          label: `${selected.has(entry.id) ? "✓ " : ""}${plain(discordDirectoryEntryLabel(view, entry))}`,
          hint: entry.kind,
        })),
        { value: "save", label: "Save selection" },
        { value: "clear", label: "Clear selection" },
      ],
    });
    if (choice === undefined) return undefined;
    if (choice === "save") return [...selected];
    if (choice === "clear") selected.clear();
    else if (selected.has(choice)) selected.delete(choice);
    else selected.add(choice);
  }
}
async function pick(
  flow: SetupFlow,
  view: DiscordSetupView,
  part: DiscordSetupPicker,
  message: string,
): Promise<DiscordPickerSelection | undefined> {
  const directoryKind =
    part.picker === "channels" ? "channels" : part.picker === "computer_access" ? "people" : "servers";
  if (view.directories.some((directory) => directory.kind === directoryKind && directory.state === "partial"))
    message += `\n${discordSetupLabel(view.snapshot, "partial_directory")}`;
  if (part.picker === "server") {
    const choices = discordPickerEntries(view, part);
    const currentValue = discordPickerIds(view.snapshot, part)[0];
    const id = await flow.readSelect({
      message,
      allowBack: true,
      options: [
        ...choices.map((entry) => ({
          value: entry.id,
          label: plain(discordDirectoryEntryLabel(view, entry)),
        })),
        { value: "keep", label: "Keep the current choice" },
      ],
      ...(currentValue ? { currentValue } : {}),
    });
    return id === "keep" ? { unchanged: true } : id ? { ids: [id] } : undefined;
  }
  if (part.picker === "channels") {
    const ids = await pickMultiple(flow, view, part, message);
    return ids ? { ids } : undefined;
  }
  if (part.picker === "team_visibility") {
    const choice = await flow.readSelect({
      message,
      allowBack: true,
      options: [
        { value: "visible", label: discordSetupLabel(view.snapshot, "team_visible") },
        { value: "hidden", label: discordSetupLabel(view.snapshot, "team_hidden") },
      ],
    });
    return choice ? { visible: choice === "visible" } : undefined;
  }
  const access = (await flow.readSelect({
    message,
    allowBack: true,
    options: (["deny", "owner_only", "allowlist", "guild_members"] as const).map((value) => ({
      value,
      label: discordSetupLabel(view.snapshot, value),
    })),
  })) as DiscordAccessChoice | undefined;
  if (!access) return undefined;
  if (access === "deny" || access === "owner_only") return { access };
  const ids = await pickMultiple(flow, view, part, message, access);
  return ids ? { access, ids } : undefined;
}
export async function runDiscordSetup(
  shell: ClankieFaceShell,
  api: DiscordSetupApi,
  advanced: () => Promise<void>,
): Promise<void> {
  const client = new DiscordSetupClient(api);
  const flow = shell.setupFlow;
  flow.begin("discord");
  try {
    for (;;) {
      const view = await client.read();
      const choice = await flow.readSelect({
        message: "Discord",
        options: [
          ...view.sentences.map((sentence) => ({
            value: sentence.id,
            label: plain(sentence.text),
            description: plain(sentence.help),
            hint: sentence.checks
              .map((check) => `${check.status === "passed" ? "✓" : "not checked"} ${plain(check.label)}`)
              .join(" · "),
          })),
          { value: "advanced", label: "Advanced" },
          { value: "done", label: "Done" },
        ],
      });
      if (!choice || choice === "done") return;
      if (choice === "advanced") {
        await advanced();
        continue;
      }
      const sentence = view.snapshot.setup!.definition.sentences.find((item) => item.id === choice)!;
      const changes: { pickerIndex: number; selection: DiscordPickerSelection }[] = [];
      let cancelled = false;
      for (const [pickerIndex, part] of discordSetupPickers(sentence).entries()) {
        const selection = await pick(
          flow,
          view,
          part,
          `${plain(view.sentences.find((item) => item.id === choice)!.text)}\n${plain(part.placeholder)} · ${plain(sentence.help)}`,
        );
        if (!selection) {
          cancelled = true;
          break;
        }
        changes.push({ pickerIndex, selection });
      }
      if (cancelled) continue;
      try {
        const saved = await client.applySentence(view, sentence.id, changes);
        shell.insertCommandResult(
          "/discord",
          `${formatDiscordSetup(saved)}\n\nSaved. Restart the Discord connection to apply server and room changes.`,
          "success",
        );
      } catch (error) {
        shell.insertCommandResult(
          "/discord",
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    }
  } finally {
    flow.end();
  }
}
