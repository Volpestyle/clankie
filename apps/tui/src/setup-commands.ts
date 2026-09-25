/**
 * `/setup`: the one place a new owner starts, and the place anyone comes back
 * to for the rest.
 *
 * Only one thing is required before Clankie can take a turn — a model and
 * something to sign it in — so an unready install goes straight to that and
 * nothing else. Once he can think, `/setup` is a checklist of his optional
 * rooms, each showing its current state and opening the command that already
 * owns it. The last entry hands the walkthrough to Clankie himself: he reads
 * the install card and can set every non-secret setting through his launcher.
 */
import type { CaptainReadiness } from "@clankie/model-provider";
import type { InstallDoctorReport } from "./install-doctor.ts";
import type { AutostartCommandResult } from "./command/autostart.ts";
import { readCaptainReadiness, runThinkingSetup, type ProviderServices } from "./provider-commands.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface SetupCommandServices {
  readonly provider: ProviderServices;
  /** Whether this console reaches his service with a conversation to talk in. */
  readonly canTalk: () => boolean;
  readonly doctor: () => Promise<InstallDoctorReport>;
  readonly autostart: (verb: "status" | "enable") => Promise<AutostartCommandResult>;
  /** Every console command, read when an entry opens one, so `/setup` never duplicates a wizard. */
  readonly commands: () => readonly FaceShellCommand[];
  readonly restartCaptain?: () => Promise<void>;
  /** Called when readiness changes, so the footer drops its `/setup` hint. */
  readonly onReady?: () => void;
}

/** What the owner sends to let Clankie take the rest of the walkthrough; editable before sending. */
export const WALKTHROUGH_DRAFT =
  "Hi Clankie! Introduce yourself, then walk me through what else of you I can set up.";

export function buildSetupCommands(services: SetupCommandServices): FaceShellCommand[] {
  return [
    {
      name: "setup",
      aliases: ["onboard"],
      description: "Get Clankie thinking, then set up his other rooms",
      takesArgument: false,
      async run(_argument, shell): Promise<void> {
        const readiness = await readCaptainReadiness(services.provider);
        if (!readiness.ready) {
          await runFirstSetup(shell, services);
          return;
        }
        await runSetupChecklist(shell, services, readiness);
      },
    },
  ];
}

/** The required step, then a handoff to Clankie. Also what a fresh console opens on its own. */
export async function runFirstSetup(shell: ClankieFaceShell, services: SetupCommandServices): Promise<void> {
  const readiness = await runThinkingSetup(shell, services.provider, {
    restartCaptain: services.restartCaptain,
  });
  if (!readiness.ready) {
    shell.insertMarkdown(
      [
        "**Clankie can't think yet**",
        "",
        notReadyLine(readiness),
        "Run `/setup` whenever you're ready — it's two questions.",
      ].join("\n"),
    );
    return;
  }
  services.onReady?.();
  if (!services.canTalk()) {
    // Ready to think is not reachable: inviting a message here would only fail.
    shell.insertMarkdown(
      [
        "**Clankie can think, but this console can't reach him**",
        "",
        `He'll think with \`${readiness.model}\` once his service answers.`,
        "`clankie status` shows what's down and `clankie restart` starts it; then reopen the console and say hi.",
      ].join("\n"),
    );
    return;
  }
  shell.insertMarkdown(
    [
      "**Clankie is ready**",
      "",
      `He thinks with \`${readiness.model}\`. That's all he needs; everything else is optional.`,
      "Say hi — the draft below asks him to walk you through the rest. `/setup` lists it too.",
    ].join("\n"),
  );
  shell.setDraft(WALKTHROUGH_DRAFT);
}

function notReadyLine(readiness: Extract<CaptainReadiness, { ready: false }>): string {
  return readiness.reason === "no_model"
    ? "No model is chosen, so every message would fail."
    : `\`${readiness.model}\` is chosen, but nothing signs in to ${readiness.providerId}.`;
}

interface ChecklistEntry {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
  readonly description?: string;
  /** The console command this entry opens. */
  readonly command?: string;
}

async function runSetupChecklist(
  shell: ClankieFaceShell,
  services: SetupCommandServices,
  readiness: Extract<CaptainReadiness, { ready: true }>,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("setup");
  let entries: readonly ChecklistEntry[];
  let picked: string | undefined;
  try {
    flow.setStatus("reading this install…");
    const [report, autostart] = await Promise.all([
      services.doctor(),
      services.autostart("status").catch(() => undefined),
    ]);
    flow.setStatus(undefined);
    entries = checklistEntries(report, readiness, autostart);
    picked = await flow.readSelect({
      message: "Clankie can think. What else would you like to set up?",
      options: entries.map(({ value, label, hint, description }) => ({
        value,
        label,
        hint,
        ...(description === undefined ? {} : { description }),
      })),
    });
  } finally {
    flow.end();
  }
  if (picked === undefined) return;
  if (picked === "ask") {
    if (!services.canTalk()) {
      shell.insertCommandResult(
        "/setup",
        "This console can't reach Clankie's service, so he can't answer yet. `clankie status` shows what's down.",
        "error",
      );
      return;
    }
    shell.setDraft(WALKTHROUGH_DRAFT);
    return;
  }
  if (picked === "think") {
    const after = await runThinkingSetup(shell, services.provider, {
      restartCaptain: services.restartCaptain,
    });
    services.onReady?.();
    if (after.ready) shell.insertCommandResult("/setup", `Clankie thinks with ${after.model}.`, "success");
    return;
  }
  if (picked === "autostart") {
    try {
      const result = await services.autostart("enable");
      shell.insertCommandResult(
        "/setup",
        `Clankie now starts when you log in (${result.label}). Keep the Mac awake to reach him while away.`,
        "success",
      );
    } catch (error) {
      shell.insertCommandResult(
        "/setup",
        `Autostart was not enabled: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return;
  }
  const entry = entries.find((candidate) => candidate.value === picked);
  const command = services.commands().find((candidate) => candidate.name === entry?.command);
  if (command === undefined) return;
  await command.run("", shell);
}

export function checklistEntries(
  report: InstallDoctorReport,
  readiness: Extract<CaptainReadiness, { ready: true }>,
  autostart: AutostartCommandResult | undefined,
): ChecklistEntry[] {
  const discord = report.discord;
  const discordOn = discord.textIngressEnabled || discord.voiceEnabled || discord.userSessionEnabled;
  const workers = ["codex", "claude"].filter((name) => report.commands[name]?.present === true);
  return [
    {
      value: "think",
      label: "How he thinks",
      hint: `✓ ${readiness.model}`,
      description: "Change the sign-in or the model. Reasoning effort is /effort.",
    },
    {
      value: "persona",
      label: "His name and character",
      hint: report.persona.displayName === "Clankie" ? "default" : `✓ ${report.persona.displayName}`,
      command: "persona",
    },
    ...(autostart === undefined
      ? []
      : [
          {
            value: autostart.status === "enabled" ? "done" : "autostart",
            label: "Start at login",
            hint: autostart.status === "enabled" ? "✓ on" : "off",
            description: "Keeps him running after you close the console or restart the Mac.",
          },
        ]),
    {
      value: "phone",
      label: "Reach him from your phone",
      hint: doorwayHint(report.doorway.state),
      description:
        report.doorway.state === "connected"
          ? "This Mac is signed in; pair a phone or iPad."
          : "Sign this Mac in to api.clankie.bot, then pair the app.",
      command: report.doorway.state === "connected" ? "pair" : "gateway",
    },
    {
      value: "discord",
      label: "Discord",
      hint: discordOn ? `✓ ${discord.activeBody === "bot" ? "bot" : "lab user"}` : "off",
      description: "A bot in your server: text, voice, and pictures.",
      command: "discord",
    },
    {
      value: "voice",
      label: "His voice",
      hint: `${report.voice.realtimeProvider} / ${report.voice.ttsProvider}`,
      description: "Realtime and speech providers for Discord voice.",
      command: "voice",
    },
    {
      value: "images",
      label: "Pictures",
      hint: report.imageModel === null ? "off" : `✓ ${report.imageModel}`,
      command: "image-model",
    },
    {
      value: "video",
      label: "Video",
      hint: report.videoModel === null ? "off" : `✓ ${report.videoModel}`,
      command: "video-model",
    },
    {
      value: "games",
      label: "Pokémon",
      hint: report.gameplay.pokeagentMmoEnabled ? "✓ on" : "off",
      description: "His seat in the hosted PokeAgents world.",
      command: "games",
    },
    {
      value: "connect",
      label: "Linear and email",
      hint: report.emailConfigured ? "✓ email" : "not connected",
      command: "connect",
    },
    {
      value: "workers",
      label: "Worker agents",
      hint: workers.length === 0 ? "no codex or claude found" : `✓ ${workers.join(", ")}`,
      description: "Harnesses he leads in Herdr keep their own logins (`codex login`, `claude login`).",
      command: "herdr",
    },
    {
      value: "ask",
      label: "Ask Clankie to walk me through it",
      hint: "he knows what's set",
      description: "Drafts a message to him. He can set anything non-secret himself.",
    },
    { value: "done", label: "Done", hint: "" },
  ];
}

function doorwayHint(state: InstallDoctorReport["doorway"]["state"]): string {
  switch (state) {
    case "connected":
      return "✓ signed in";
    case "connecting":
      return "connecting";
    case "sign_in_required":
      return "signed out";
    case "unavailable":
      return "not connected";
    case "unreachable":
    case "disabled":
      return "off";
  }
}
