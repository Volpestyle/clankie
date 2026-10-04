import { runDesktopCommand } from "../src/command/desktop.ts";
import { runHarnessCommand } from "../src/command/harness.ts";
import { runUpdateCommand } from "../src/command/update.ts";
import { runBodyCommand } from "../src/command/body.ts";
import { MachineInventorySchema } from "@clankie/protocol";
import { runMachinesCommand, formatMachines, MACHINE_RESTART_HINT } from "../src/command/machines.ts";
import { runWorkOnCommand } from "../src/command/work-on.ts";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import {
  connectHostedCli,
  disconnectHostedCli,
  hostedCommand,
  hostedWhoami,
  hostedTransportFor,
  HOSTED_LOCAL_ONLY,
} from "../src/command/hosted.ts";
import { runRuntimeCommand } from "../src/command/runtime.ts";
import { runSeatHookCommand } from "../src/command/seat-hook.ts";
import { runSeatSyncCommand } from "../src/command/seat-sync.ts";
import { runAgentsCommand } from "../src/command/agents.ts";
import { runProjectCommand } from "../src/command/project.ts";
import { runProjectSettingsCommand } from "../src/command/project-settings.ts";
import { runAccessCommand } from "../src/command/access.ts";
import { runEvaluatorCommand } from "../src/command/evaluator.ts";
import { runConversationsCommand } from "../src/command/conversations.ts";
import { openHerdr, runFleetHerdr } from "../src/session/herdr-connection.ts";
import { type CredentialStore } from "@clankie/credential-broker";
import { type ServiceRegistryOptions } from "./services.ts";
import { doctorCommand, machineDoctorCommand, type ExecFileImpl } from "../src/command/doctor.ts";
import { statusCommand } from "../src/command/status.ts";
import { runModelCommand } from "../src/command/model.ts";
import { runPersonaCommand } from "../src/command/persona.ts";
import { runBrowserCommand } from "../src/command/browser.ts";
import { runSkillsCommand } from "../src/command/skills.ts";
import { runGamesCommand } from "../src/command/games.ts";
import { runLinearCommand } from "../src/command/linear.ts";
import { runAccountsCommand } from "../src/command/accounts.ts";
import { runWorkCommand } from "../src/command/work.ts";
import { runFleetCommand } from "../src/command/fleet.ts";
import { forwardsToFleetHerdr, herdrFleetRuntimeArgs, runHerdrCommand } from "../src/command/herdr.ts";
import { runWorkdirCommand } from "../src/command/workdir.ts";
import { runEffortCommand } from "../src/command/effort.ts";
import { runVoiceCommand } from "../src/command/voice.ts";
import { runImageModelCommand } from "../src/command/image-model.ts";
import { runVideoModelCommand } from "../src/command/video-model.ts";
import { runDiscordCommand } from "../src/command/discord.ts";
import { runRestartCommand, runDownCommand } from "../src/command/restart.ts";
import { runPairCommand } from "../src/command/pair.ts";
import { runDevicesCommand } from "../src/command/devices.ts";
import { runPlayCommand } from "../src/command/play.ts";
import { runRivalsCommand } from "../src/command/rivals.ts";
import { runMinecraftCommand } from "../src/command/minecraft.ts";
import { runStanceCommand } from "../src/command/stance.ts";
import { runPromptCommand } from "../src/command/prompt.ts";
import { runResetCommand } from "../src/command/reset.ts";
import { runSendCommand } from "../src/command/send.ts";
import { runFileCommand } from "../src/command/file.ts";
import { runMemoryCardCommand } from "../src/command/memory-card.ts";
import { runMemoryCommand } from "../src/command/memory.ts";
import { runMetricsCommand } from "../src/command/metrics.ts";
import { runTelemetryCommand } from "../src/command/telemetry.ts";
import { runSeatCommand } from "../src/command/seat.ts";
import { operatorHarness } from "../src/command/harness-command.ts";
import { runMcpCommand } from "../src/command/mcp.ts";
import { runOperatorCredentialCommand } from "../src/command/operator-credential.ts";
import { runGatewayCommand } from "../src/command/gateway.ts";
import { runAutostartCommand } from "../src/command/autostart.ts";
import { runAwakeCommand } from "../src/command/awake.ts";
import { commandHelp } from "../src/command/registry.ts";
import { outputJson, type Writable } from "../src/command/io.ts";

export { isHeadlessCaptainCommand, unknownLauncherCommand } from "../src/command/registry.ts";

export interface HeadlessCaptainCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  readonly operatorCredentialStore?: CredentialStore;
  /** Test seam for the brokered captain bearer the launcher injects. */
  readonly captainCredentialStore?: CredentialStore;
  /**
   * Test seam for the process-table scan. Without it a service probe reads the
   * real machine, so a developer with a live bridge running sees a different
   * status than CI does.
   */
  readonly listProcessCommandsImpl?: () => readonly (readonly [number, string])[];
  readonly listPortOwnersImpl?: ServiceRegistryOptions["listPortOwnersImpl"];
  readonly repoRoot: string;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly spawnImpl?: ServiceRegistryOptions["spawnImpl"];
  readonly killImpl?: ServiceRegistryOptions["killImpl"];
  readonly processIsAliveImpl?: ServiceRegistryOptions["processIsAliveImpl"];
  readonly readProcessCommandImpl?: ServiceRegistryOptions["readProcessCommandImpl"];
  /** Test seam for the executable a deferred self-restart launches. */
  readonly cliEntryPath?: string;
  /** Test seam so `clankie doctor` does not probe the real PATH. */
  readonly execFileImpl?: ExecFileImpl;
  readonly stderr?: Writable;
  readonly stdout?: Writable;
}

export async function runHeadlessCaptainCommand(
  args: readonly string[],
  options: HeadlessCaptainCommandOptions,
): Promise<number> {
  const command = args[0];
  const rest = args.slice(1);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const env = options.env ?? process.env;
    if (command === "connect" || command === "login") {
      await connectHostedCli(
        command === "login" ? ["hosted", ...rest] : rest,
        env,
        stdout,
        command === "login" ? { target: "auto" } : {},
      );
      return 0;
    }
    if ((command === "gateway" || command === "remote-access") && rest[0] === "on") {
      await connectHostedCli(["hosted", ...rest.slice(1)], env, stdout, { target: "this-mac" });
      return 0;
    }
    if (command === "whoami") {
      outputJson(stdout, await hostedWhoami(env));
      return 0;
    }
    if (command === "disconnect" || command === "logout") {
      outputJson(stdout, await disconnectHostedCli(env));
      return 0;
    }
    if (
      !options.host &&
      !options.fetchImpl &&
      (await new SettingsStore(defaultSettingsPath(env)).load()).client?.mode === "hosted" &&
      !["help", "--help", "-h"].includes(command ?? "")
    ) {
      const discordHttp =
        command === "discord" &&
        ["setup", "definition", "directory", "rooms", "guide", "call"].includes(rest[0] ?? "");
      if ((HOSTED_LOCAL_ONLY.has(command ?? "") && !discordHttp) || operatorHarness(command) !== undefined)
        throw new Error(`${command} is managed by the hosted service; no local action was taken.`);
      const transport = await hostedTransportFor(env);
      // These existing commands are HTTP-only. The transport replaces their local
      // bearer inside the envelope; no Mac credential is read or transmitted.
      if (["conversations", "conversation", "send"].includes(command ?? "") || discordHttp)
        return runHeadlessCaptainCommand(args, {
          ...options,
          ...transport,
          env: {
            ...env,
            CLANKIE_CAPTAIN_TOKEN: "hosted-device-transport",
            CLANKIE_OPERATOR_TOKEN: "hosted-device-transport",
          },
        });
      outputJson(stdout, await hostedCommand(args, transport));
      return 0;
    }
    if (command === "health" || command === "status") {
      const result = await statusCommand(options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      if (rest.length) {
        if (rest.length !== 2 || rest[0] !== "--machine")
          throw new Error("Usage: clankie doctor [--machine FLEET_ID]");
        outputJson(stdout, await machineDoctorCommand(rest[1]!, options));
        return 0;
      }
      const result = await doctorCommand({
        repoRoot: options.repoRoot,
        env: options.env ?? process.env,
        ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
      });
      outputJson(stdout, result);
      return 0;
    }
    if (command === "update") {
      outputJson(stdout, await runUpdateCommand(rest, options));
      return 0;
    }
    if (command === "restart") return await runRestartCommand(rest, options);
    if (command === "down") return await runDownCommand(rest, options);
    if (command === "autostart") {
      const result = await runAutostartCommand(rest, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
      });
      outputJson(stdout, result);
      return 0;
    }
    if (command === "awake") {
      outputJson(stdout, await runAwakeCommand(rest, options));
      return 0;
    }
    if (command === "pair") return await runPairCommand(rest, options);
    if (command === "devices") return await runDevicesCommand(rest, options);
    if (command === "operator-credential") return await runOperatorCredentialCommand(rest, options);
    if (command === "gateway" || command === "remote-access") {
      const result = await runGatewayCommand(rest, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.operatorCredentialStore === undefined
          ? {}
          : { credentials: options.operatorCredentialStore }),
      });
      outputJson(stdout, result);
      return 0;
    }
    if (command === "play") return await runPlayCommand(rest, options);
    if (command === "minecraft") {
      outputJson(stdout, await runMinecraftCommand(rest, options));
      return 0;
    }
    if (command === "rivals") {
      const result = await runRivalsCommand(rest, options);
      outputJson(stdout, result);
      return result.outcome === "refused" ? 1 : 0;
    }
    if (command === "model") {
      const result = await runModelCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "effort") {
      const result = await runEffortCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "voice") {
      outputJson(stdout, await runVoiceCommand(rest, options));
      return 0;
    }
    if (command === "image-model") {
      const result = await runImageModelCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "video-model") {
      const result = await runVideoModelCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "persona") {
      const result = await runPersonaCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "body") {
      outputJson(stdout, await runBodyCommand(rest, options));
      return 0;
    }
    if (command === "browser") {
      outputJson(stdout, await runBrowserCommand(rest, options));
      return 0;
    }
    if (command === "skills") {
      outputJson(stdout, await runSkillsCommand(rest, options));
      return 0;
    }
    if (command === "desktop") {
      outputJson(stdout, await runDesktopCommand(rest, options));
      return 0;
    }
    if (command === "games") {
      const result = await runGamesCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "linear") {
      const result = await runLinearCommand(rest, options);
      outputJson(stdout, result);
      return result.ok === false ? 1 : 0;
    }
    if (command === "accounts") {
      outputJson(stdout, await runAccountsCommand(rest, options));
      return 0;
    }
    if (command === "work") {
      const result = await runWorkCommand(rest, options);
      outputJson(stdout, result.body);
      return result.ok ? 0 : 1;
    }
    if (command === "connections") {
      outputJson(stdout, await runRuntimeCommand(["inventory"], options));
      return 0;
    }
    if (command === "machines") {
      const result = await runMachinesCommand(rest, options);
      const inventory = MachineInventorySchema.safeParse(result);
      if (!rest.includes("--json") && inventory.success) stdout.write(`${formatMachines(inventory.data)}\n`);
      else outputJson(stdout, result);
      return 0;
    }
    if (command === "runtime") {
      outputJson(stdout, await runRuntimeCommand(rest, options));
      return 0;
    }
    if (command === "agents" || command === "sessions") {
      outputJson(stdout, await runAgentsCommand(rest, options));
      return 0;
    }
    if (command === "harness") {
      outputJson(stdout, await runHarnessCommand(rest, options));
      return 0;
    }
    if (command === "project") {
      outputJson(
        stdout,
        await (["list", "update", "create", "membership"].includes(rest[0] ?? "")
          ? runProjectSettingsCommand(rest, options)
          : runProjectCommand(rest, options)),
      );
      return 0;
    }
    if (command === "access") {
      outputJson(stdout, await runAccessCommand(rest, options));
      return 0;
    }
    if (command === "fleet") {
      const result = await runFleetCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "herdr") {
      if (!rest.length) return await openHerdr(options);
      if (rest[0] === "help" || rest[0] === "--help") {
        stdout.write(
          "clankie herdr: open | status [--json] | use NAME | create | disable | fleets | add | remove | prepare\n",
        );
        return 0;
      }
      if (rest[0] === "status") {
        const inventory = MachineInventorySchema.parse(await runMachinesCommand([], options));
        if (rest.includes("--json"))
          outputJson(stdout, { ...(await runHerdrCommand(["status"], options)), ...inventory });
        else stdout.write(`${formatMachines(inventory)}\n`);
        return 0;
      }
      if (rest[0] === "fleets") {
        const result = await runMachinesCommand(rest.includes("--json") ? ["--json"] : [], options);
        if (rest.includes("--json")) outputJson(stdout, result);
        else stdout.write(`${formatMachines(MachineInventorySchema.parse(result))}\n`);
        return 0;
      }
      if (rest[0] === "remove" || (rest[0] === "add" && !rest.includes("--session"))) {
        outputJson(stdout, await runMachinesCommand(rest, options));
        return 0;
      }
      if (rest[0] === "--connection") {
        const connectionId = rest[1];
        if (!connectionId || !/^[a-z][a-z0-9-]{0,63}$/u.test(connectionId))
          throw new Error("Select a runtime connection ID");
        const target = { ...options, connectionId };
        const args = rest.slice(2);
        if (args.length === 1 && args[0] === "open") return await openHerdr(target);
        if (!args.length) throw new Error("Supply a Herdr command or open");
        return await runFleetHerdr(args, target);
      }
      if (rest.length === 1 && rest[0] === "open") return await openHerdr(options);
      const fleetArgs = herdrFleetRuntimeArgs(rest);
      if (fleetArgs !== undefined) {
        outputJson(stdout, {
          ...(await runRuntimeCommand(fleetArgs, options)),
          hint: MACHINE_RESTART_HINT,
        });
        return 0;
      }
      if (forwardsToFleetHerdr(rest)) return await runFleetHerdr(rest, options);
      const result = await runHerdrCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "workdir") {
      const result = await runWorkdirCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "stance") {
      return await runStanceCommand(rest, { ...options, stdout });
    }
    if (command === "work-on") {
      return await runWorkOnCommand(rest, { ...options, stdout });
    }
    // Prompt and memory card print the words themselves, not a JSON envelope:
    // the consumer is another harness's system prompt or a per-turn hook.
    if (command === "prompt") {
      return await runPromptCommand(rest, { ...options, stdout });
    }
    if (command === "reset") return await runResetCommand(rest, options);
    if (command === "conversations" || command === "conversation")
      return await runConversationsCommand(rest, options);
    if (command === "send") return await runSendCommand(rest, { ...options, stdout });
    if (command === "file") return await runFileCommand(rest, { ...options, stdout });
    if (command === "memory-card") {
      return await runMemoryCardCommand(rest, { ...options, stdout });
    }
    if (command === "memory") {
      const result = await runMemoryCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "evaluator") {
      const result = await runEvaluatorCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "telemetry") return await runTelemetryCommand(rest, { stdout, stderr });
    if (command === "metrics") {
      const result = await runMetricsCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    // The seat: Claude Code as Clankie (ADR 0152). `mcp` is its stdio side and
    // speaks JSON-RPC on stdout, so it never goes through outputJson.
    if (command === "seat-sync") return await runSeatSyncCommand(rest, options);
    if (command === "seat-hook") return await runSeatHookCommand(rest, options);
    if (command === "seat" || operatorHarness(command) !== undefined) {
      return await runSeatCommand(rest, {
        ...(command === "seat" ? {} : { harnessCommand: command }),
        repoRoot: options.repoRoot,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.operatorCredentialStore === undefined
          ? {}
          : { operatorCredentialStore: options.operatorCredentialStore }),
        stdout,
        stderr,
      });
    }
    if (command === "mcp") {
      return await runMcpCommand(rest, { ...options, stderr });
    }
    if (command === "discord") {
      const result = await runDiscordCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "help" || command === "--help" || command === "-h") {
      stdout.write(`${commandHelp()}\n`);
      return 0;
    }
    throw new Error(commandHelp());
  } catch (error) {
    stderr.write(`clankie: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
