/** `/setup` chains the existing model, phone and integration commands, then hands hiring to Clankie. */
import { setTimeout as delay } from "node:timers/promises";
import type { DeviceListItem, OperatorAgentPersona } from "@clankie/protocol";
import type { CaptainReadiness } from "@clankie/model-provider";
import type { InstallDoctorReport } from "./install-doctor.ts";
import type { AutostartCommandResult } from "./command/autostart.ts";
import { readCaptainReadiness, runThinkingSetup, type ProviderServices } from "./provider-commands.ts";
import { resolveWorkspacePath } from "./session/workspace.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface SetupCommandServices {
  readonly provider: ProviderServices;
  /** Whether this console reaches his service with a conversation to talk in. */
  readonly canTalk: () => boolean;
  readonly doctor: () => Promise<InstallDoctorReport>;
  readonly devices: (signal: AbortSignal) => Promise<readonly DeviceListItem[]>;
  readonly agents: () => Promise<readonly OperatorAgentPersona[]>;
  readonly workspace: () => string;
  readonly pair: (shell: ClankieFaceShell) => Promise<number>;
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
      description: "Model sign-in, phone pairing, then your first agent",
      argumentHint: "[rooms]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() && argument.trim() !== "rooms") {
          shell.insertCommandResult("/setup", "Usage: /setup [rooms]", "error");
          return;
        }
        const readiness = await readCaptainReadiness(services.provider);
        if (!readiness.ready) {
          await runFirstSetup(shell, services);
          return;
        }
        if (argument.trim() === "rooms") await runSetupChecklist(shell, services, readiness);
        else await runGuidedSetup(shell, services, readiness);
      },
    },
  ];
}

/** A fresh console starts here, then stays in the same guided path. */
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
  await runGuidedSetup(shell, services, readiness);
}

/** No persisted wizard state: every return reads the actual credentials, devices and roster. */
async function runGuidedSetup(
  shell: ClankieFaceShell,
  services: SetupCommandServices,
  readiness: Extract<CaptainReadiness, { ready: true }>,
): Promise<void> {
  shell.insertCommandResult("/setup", `1 of 3 · Clankie thinks with ${readiness.model}.`, "success");
  if (!services.canTalk()) {
    shell.insertCommandResult(
      "/setup",
      "Clankie is not reachable yet. Run `clankie restart`, then return to /setup.",
      "error",
    );
    return;
  }
  if (!(await setupPhone(shell, services))) return;

  const flow = shell.setupFlow;
  flow.begin("setup · connections");
  let connect: string | undefined;
  try {
    connect = await flow.readSelect({
      message: "Optional: give Clankie access to your services",
      options: [
        { value: "skip", label: "Continue to my first agent", hint: "connect services anytime" },
        { value: "connect", label: "Connect Linear, email or Discord", hint: "opens /connect" },
      ],
    });
  } finally {
    flow.end();
  }
  if (connect === undefined) return;
  if (connect === "connect") await openSetupCommand(shell, services, "connect");

  const existing = (await services.agents()).find((agent) => agent.activeSeatId !== undefined);
  if (existing) {
    shell.insertCommandResult(
      "/setup",
      `3 of 3 · ${existing.name} already has a live agent seat. /agents opens the team; /setup rooms has the other settings.`,
      "success",
    );
    return;
  }
  flow.begin("setup · first agent");
  let workspace: string | undefined;
  let task: string | undefined;
  let action: string | undefined;
  let request = "";
  try {
    workspace = await flow.readText({
      message: "3 of 3 · Which folder should your first agent work in?",
      defaultValue: services.workspace(),
      validate: (value) => {
        try {
          resolveWorkspacePath(value, services.workspace());
          return undefined;
        } catch {
          return "Choose an existing folder on this Mac, or Escape to stop.";
        }
      },
    });
    if (workspace === undefined) return;
    workspace = resolveWorkspacePath(workspace, services.workspace());
    task = await flow.readText({
      message: "3 of 3 · What should your first agent do?",
      defaultValue: "Explore this folder and report what is here. Do not change files.",
      validate: (value) => (value.trim() ? undefined : "Give the agent a task, or Escape to stop."),
    });
    if (task === undefined) return;
    request = `Please help me hire my first native agent in your Herdr workspace for ${JSON.stringify(workspace)}. Task: ${task.trim()}\nChoose a suitable installed harness and lead the agent through its normal native channel. If a harness or its sign-in needs setup, walk me through it here. Tell me who was hired and how I can reach them.`;
    action = await flow.readSelect({
      message: `Ask Clankie to hire an agent in ${workspace}?`,
      options: [
        { value: "send", label: "Send the hire request", description: task.trim() },
        { value: "draft", label: "Edit the request first", hint: "puts it in the composer" },
        { value: "later", label: "Do this later" },
      ],
    });
  } finally {
    flow.end();
  }
  if (action === "draft") {
    shell.setDraft(request);
    shell.insertCommandResult(
      "/setup",
      "Review the request below, then press Enter. Clankie will handle the hire; /agents shows live seats.",
      "success",
    );
  } else if (action === "send") {
    await shell.submitUserPrompt(request);
    const hired = (await services.agents()).find((agent) => agent.activeSeatId !== undefined);
    shell.insertCommandResult(
      "/setup",
      hired
        ? `3 of 3 · ${hired.name} has a live agent seat. /agents opens the team; /setup rooms has the other settings.`
        : "No live agent seat is observed yet. Continue with Clankie above to finish the hire; /agents shows the team. Return to /setup anytime.",
      hired ? "success" : "error",
    );
  }
}

async function openSetupCommand(
  shell: ClankieFaceShell,
  services: SetupCommandServices,
  name: string,
): Promise<void> {
  const command = services.commands().find((candidate) => candidate.name === name);
  if (!command) throw new Error(`/${name} is unavailable in this console.`);
  await command.run("", shell);
}

async function setupPhone(shell: ClankieFaceShell, services: SetupCommandServices): Promise<boolean> {
  const flow = shell.setupFlow;
  for (;;) {
    const devices = await services.devices(AbortSignal.timeout(5_000));
    const phone = devices.find(
      (device) =>
        device.status === "active" &&
        (device.platform === "ios" || device.platform === "android") &&
        device.grants.chat,
    );
    if (phone) {
      shell.insertCommandResult("/setup", `2 of 3 · ${phone.name} is paired and active.`, "success");
      return true;
    }
    const report = await services.doctor();
    const needsSignIn = report.doorway.state !== "connected";
    flow.begin("setup · phone");
    let action: string | undefined;
    try {
      action = await flow.readSelect({
        message: "2 of 3 · Pair your phone or iPad",
        options: [
          {
            value: "pair",
            label: needsSignIn ? "Sign this Mac in, then pair my phone" : "Pair my phone",
            hint: "Clankie app → scan QR",
            description:
              "Get the app at clankie.bot/#app, then open it on your phone. This uses /remote-access and /pair.",
          },
          { value: "skip", label: "Do this later", hint: "continue to the first agent" },
        ],
      });
    } finally {
      flow.end();
    }
    if (action === undefined) return false;
    if (action === "skip") {
      shell.insertCommandResult(
        "/setup",
        "Phone pairing skipped. Return to /setup or /pair when you have the app.",
        "success",
      );
      return true;
    }
    if (needsSignIn) {
      await openSetupCommand(shell, services, "remote-access");
      if ((await services.doctor()).doorway.state !== "connected") {
        shell.insertCommandResult(
          "/setup",
          "Phone access is not connected yet. Choose sign-in again, or pair later.",
          "error",
        );
        continue;
      }
    }
    if ((await services.pair(shell)) !== 0) continue;
    // Keep the QR visible instead of covering it with another modal. /cancel
    // stops waiting; neither a minted offer nor a pending device counts as paired.
    flow.begin("setup · waiting for phone");
    flow.setStatus("Scan the QR in the Clankie app. Waiting for an active phone… /cancel to stop");
    const interrupt = flow.waitForInterrupt();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    void interrupt.promise.then(() => controller.abort());
    try {
      while (!signal.aborted) {
        const paired = (await services.devices(signal)).find(
          (device) =>
            device.status === "active" &&
            (device.platform === "ios" || device.platform === "android") &&
            device.grants.chat,
        );
        if (paired) {
          shell.insertCommandResult("/setup", `2 of 3 · ${paired.name} is paired and active.`, "success");
          return true;
        }
        await delay(2_000, undefined, { signal });
      }
    } catch (error) {
      if (!signal.aborted)
        shell.insertCommandResult(
          "/setup",
          `Pairing check failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
    } finally {
      controller.abort();
      interrupt.dispose();
      flow.setStatus(undefined);
      flow.end();
    }
    shell.insertCommandResult(
      "/setup",
      "No active phone was confirmed. Return to /setup to check or try pairing again.",
      "error",
    );
    return false;
  }
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

  return [
    { value: "connection", label: "Local or hosted Clankie", hint: "local", command: "connection" },
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
      command: report.doorway.state === "connected" ? "pair" : "remote-access",
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
    ...((report.ownerHerdrSessions?.length ?? 0) > 0
      ? [
          {
            value: "workers",
            label: "His workspace or your Herdr session",
            hint: "His own workspace is recommended",
            description: "Leading your session lets him see and message every pane in it.",
            command: "herdr",
          },
        ]
      : []),
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
