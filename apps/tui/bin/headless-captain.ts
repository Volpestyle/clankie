import type { CaptainRouteFetcher } from "../src/session/operator-conversations.ts";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import type { CredentialStore } from "@clankie/credential-broker";
import type { ServiceRegistryOptions } from "./services.ts";
import type { ExecFileImpl } from "../src/command/doctor.ts";
import { commandHelp } from "../src/command/registry.ts";
import { outputJson, type Writable } from "../src/command/io.ts";
export { isHeadlessCaptainCommand, unknownLauncherCommand } from "../src/command/registry.ts";

export interface HeadlessCaptainCommandOptions {
  readonly ownerFetcher?: CaptainRouteFetcher;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  readonly operatorCredentialStore?: CredentialStore;
  /** Test seam for the brokered captain bearer the launcher injects. */
  readonly captainCredentialStore?: CredentialStore;
  /** Isolated registry for real subprocess integration checks. */
  readonly resourceGovernor?: import("@clankie/fleet-resources").FleetResourceGovernor;
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
    if (command === "heavy")
      return await (
        await import("../src/command/heavy.ts")
      ).runHeavyCommand(rest, {
        stderr,
        env,
        ...(options.resourceGovernor === undefined ? {} : { governor: options.resourceGovernor }),
      });
    if (command === "connect" || command === "login") {
      await (
        await import("../src/command/hosted.ts")
      ).connectHostedCli(
        command === "login" ? ["hosted", ...rest] : rest,
        env,
        stdout,
        command === "login" ? { target: "auto" } : {},
      );
      return 0;
    }
    if ((command === "gateway" || command === "remote-access") && rest[0] === "on") {
      await (
        await import("../src/command/hosted.ts")
      ).connectHostedCli(["hosted", ...rest.slice(1)], env, stdout, { target: "this-mac" });
      return 0;
    }
    // Joining/resuming is a local foreground transport even when the CLI talks to hosted Clankie.
    if (command === "join" && rest[0] !== "approve")
      return (await import("../src/command/join.ts")).runJoinCommand(rest, options);
    if (command === "whoami") {
      outputJson(stdout, await (await import("../src/command/hosted.ts")).hostedWhoami(env));
      return 0;
    }
    if (command === "disconnect" || command === "logout") {
      outputJson(stdout, await (await import("../src/command/hosted.ts")).disconnectHostedCli(env));
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
      if (
        ((await import("../src/command/hosted.ts")).HOSTED_LOCAL_ONLY.has(command ?? "") &&
          !discordHttp &&
          !(command === "update" && rest[0] === "auto")) ||
        (await import("../src/command/harness-command.ts")).operatorHarness(command) !== undefined
      )
        throw new Error(`${command} is managed by the hosted service; no local action was taken.`);
      const transport = await (await import("../src/command/hosted.ts")).hostedTransportFor(env);
      if (command === "games" && rest.length === 1 && rest[0] === "extensions") {
        outputJson(
          stdout,
          (await import("@clankie/protocol")).GameExtensionCatalogSchema.parse(
            await transport.request((await import("@clankie/protocol")).GAME_EXTENSIONS_PATH),
          ),
        );
        return 0;
      }
      // These existing commands are HTTP-only. The transport replaces their local
      // bearer inside the envelope; no Mac credential is read or transmitted.
      if (
        ["conversations", "conversation", "send", "runtime-health", "join"].includes(command ?? "") ||
        discordHttp
      )
        return runHeadlessCaptainCommand(args, {
          ...options,
          ...transport,
          env: {
            ...env,
            CLANKIE_CAPTAIN_TOKEN: "hosted-device-transport",
            CLANKIE_OPERATOR_TOKEN: "hosted-device-transport",
          },
        });
      outputJson(stdout, await (await import("../src/command/hosted.ts")).hostedCommand(args, transport));
      return 0;
    }
    if (command === "health" || command === "status") {
      const result = await (await import("../src/command/status.ts")).statusCommand(options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      const json = rest.includes("--json");
      const args = rest.filter((arg) => arg !== "--json");
      if (
        rest.filter((arg) => arg === "--json").length > 1 ||
        (args.length !== 0 && (args.length !== 2 || args[0] !== "--machine" || args[1]!.startsWith("--")))
      )
        throw new Error("Usage: clankie doctor [--machine FLEET_ID] [--json]");
      if (args.length) {
        const result = await (
          await import("../src/command/doctor.ts")
        ).machineDoctorCommand(args[1]!, options);
        if (json) outputJson(stdout, result);
        else
          stdout.write(`${(await import("../src/command/doctor.ts")).formatMachineDoctorSummary(result)}\n`);
        return 0;
      }
      const result = await (
        await import("../src/command/doctor.ts")
      ).doctorCommand({
        repoRoot: options.repoRoot,
        cwd: process.cwd(),
        env: options.env ?? process.env,
        ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
      });
      if (json) outputJson(stdout, result);
      else stdout.write(`${(await import("../src/command/doctor.ts")).formatDoctorSummary(result)}\n`);
      return 0;
    }
    if (command === "checkouts") {
      outputJson(
        stdout,
        await (await import("../src/command/checkouts.ts")).runCheckoutsCommand(rest, options),
      );
      return 0;
    }
    if (command === "update") {
      return await (
        await import("../src/command/update-output.ts")
      ).runUpdateCli(rest, { ...options, stdout });
    }
    if (command === "restart")
      return await (await import("../src/command/restart.ts")).runRestartCommand(rest, options);
    if (command === "start")
      return await (await import("../src/command/restart.ts")).runStartCommand(rest, options);
    if (command === "stop" || command === "down")
      return await (await import("../src/command/restart.ts")).runDownCommand(rest, options);
    if (command === "recover")
      return await (await import("../src/command/recover.ts")).runRecoverCommand(rest, options);
    if (command === "autostart") {
      const result = await (
        await import("../src/command/autostart.ts")
      ).runAutostartCommand(rest, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
      });
      outputJson(stdout, result);
      return 0;
    }
    if (command === "awake") {
      outputJson(stdout, await (await import("../src/command/awake.ts")).runAwakeCommand(rest, options));
      return 0;
    }
    if (command === "usage") {
      const result = await (await import("../src/command/usage.ts")).runUsageCommand(rest, options);
      // The report reads as a table by default; --json (and overlay settings) stay machine-readable.
      if (rest.includes("--json") || !("accounts" in result)) outputJson(stdout, result);
      else stdout.write(`${(await import("../src/command/usage.ts")).formatUsageTable(result)}\n`);
      return 0;
    }
    if (command === "runtime-health") {
      outputJson(
        stdout,
        await (await import("../src/command/runtime-health.ts")).runRuntimeHealthCommand(rest, options),
      );
      return 0;
    }
    if (command === "pair")
      return await (await import("../src/command/pair.ts")).runPairCommand(rest, options);
    if (command === "devices")
      return await (await import("../src/command/devices.ts")).runDevicesCommand(rest, options);
    if (command === "support")
      return await (await import("../src/command/support.ts")).runSupportCommand(rest, options);
    if (command === "operator-credential")
      return await (
        await import("../src/command/operator-credential.ts")
      ).runOperatorCredentialCommand(rest, options);
    if (command === "gateway" || command === "remote-access") {
      const result = await (
        await import("../src/command/gateway.ts")
      ).runGatewayCommand(rest, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.operatorCredentialStore === undefined
          ? {}
          : { credentials: options.operatorCredentialStore }),
      });
      outputJson(stdout, result);
      return 0;
    }
    if (command === "share") {
      const result = await (await import("../src/command/share.ts")).runShareCommand(rest, options);
      outputJson(stdout, result.body);
      return result.ok ? 0 : 1;
    }
    if (command === "play")
      return await (await import("../src/command/play.ts")).runPlayCommand(rest, options);
    if (command === "computer") {
      outputJson(
        stdout,
        await (await import("../src/command/computer.ts")).runComputerCommand(rest, options),
      );
      return 0;
    }
    if (command === "minecraft") {
      outputJson(
        stdout,
        await (await import("../src/command/minecraft.ts")).runMinecraftCommand(rest, options),
      );
      return 0;
    }
    if (command === "rivals") {
      const result = await (await import("../src/command/rivals.ts")).runRivalsCommand(rest, options);
      outputJson(stdout, result);
      return result.outcome === "refused" ? 1 : 0;
    }
    if (command === "model") {
      const result = await (await import("../src/command/model.ts")).runModelCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "effort") {
      const result = await (await import("../src/command/effort.ts")).runEffortCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "voice") {
      outputJson(stdout, await (await import("../src/command/voice.ts")).runVoiceCommand(rest, options));
      return 0;
    }
    if (command === "image-model") {
      const result = await (
        await import("../src/command/image-model.ts")
      ).runImageModelCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "video-model") {
      const result = await (
        await import("../src/command/video-model.ts")
      ).runVideoModelCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "persona") {
      const result = await (await import("../src/command/persona.ts")).runPersonaCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "body") {
      outputJson(stdout, await (await import("../src/command/body.ts")).runBodyCommand(rest, options));
      return 0;
    }
    if (command === "browser") {
      outputJson(stdout, await (await import("../src/command/browser.ts")).runBrowserCommand(rest, options));
      return 0;
    }
    if (command === "skills") {
      outputJson(stdout, await (await import("../src/command/skills.ts")).runSkillsCommand(rest, options));
      return 0;
    }
    if (command === "desktop") {
      outputJson(stdout, await (await import("../src/command/desktop.ts")).runDesktopCommand(rest, options));
      return 0;
    }
    if (command === "games") {
      if (rest.length === 1 && rest[0] === "extensions") {
        outputJson(stdout, await (await import("../src/command/games.ts")).runGameExtensionsCommand(options));
        return 0;
      }
      const result = await (await import("../src/command/games.ts")).runGamesCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "linear") {
      const result = await (await import("../src/command/linear.ts")).runLinearCommand(rest, options);
      outputJson(stdout, result);
      return result.ok === false ? 1 : 0;
    }
    if (command === "accounts") {
      outputJson(
        stdout,
        await (await import("../src/command/accounts.ts")).runAccountsCommand(rest, options),
      );
      return 0;
    }
    if (command === "work") {
      const result = await (await import("../src/command/work.ts")).runWorkCommand(rest, options);
      outputJson(stdout, result.body);
      return result.ok ? 0 : 1;
    }
    if (command === "evidence") {
      const result = await (
        await import("../src/command/evidence.ts")
      ).runEvidenceCommand(rest, { ...options, stderr });
      outputJson(stdout, result.body);
      return result.ok ? 0 : 1;
    }
    if (command === "integrate") {
      const result = await (await import("../src/command/integrate.ts")).runIntegrationCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "connections") {
      outputJson(
        stdout,
        await (await import("../src/command/runtime.ts")).runRuntimeCommand(["inventory"], options),
      );
      return 0;
    }
    if (command === "join") return (await import("../src/command/join.ts")).runJoinCommand(rest, options);
    if (command === "machines") {
      const result = await (await import("../src/command/machines.ts")).runMachinesCommand(rest, options);
      const inventory = (await import("@clankie/protocol")).MachineInventorySchema.safeParse(result);
      if (!rest.includes("--json") && inventory.success)
        stdout.write(`${(await import("../src/command/machines.ts")).formatMachines(inventory.data)}\n`);
      else outputJson(stdout, result);
      return 0;
    }
    if (command === "runtime") {
      outputJson(stdout, await (await import("../src/command/runtime.ts")).runRuntimeCommand(rest, options));
      return 0;
    }
    if (command === "agents" || command === "sessions") {
      outputJson(stdout, await (await import("../src/command/agents.ts")).runAgentsCommand(rest, options));
      return 0;
    }
    if (command === "harness") {
      if (rest[0] === "restart-tools") {
        const result = await (
          await import("../src/command/harness.ts")
        ).runWorkerToolRestartCommand(rest, options);
        outputJson(stdout, result);
        return result.outcome === "restarted" ? 0 : 1;
      }
      if (rest[0] === "login") {
        const result = await (
          await import("../src/command/harness-login.ts")
        ).runHarnessLoginCommand(rest, options);
        outputJson(stdout, result);
        return typeof result === "object" && result !== null && "ok" in result && result.ok === false
          ? 1
          : typeof result === "object" && result !== null && "state" in result && result.state !== "complete"
            ? 1
            : 0;
      }
      if (rest[0] === "refresh-tools") {
        const result = await (
          await import("../src/command/harness.ts")
        ).runWorkerToolRefreshCommand(rest, options);
        outputJson(stdout, result);
        return result.seats.some((seat) => seat.outcome === "failed") ? 1 : 0;
      }
      const result = await (await import("../src/command/harness.ts")).runHarnessCommand(rest, options);
      outputJson(stdout, result);
      return !Array.isArray(result) && result.ok === false ? 1 : 0;
    }
    if (command === "project") {
      outputJson(
        stdout,
        await (["list", "settings", "update", "create", "membership"].includes(rest[0] ?? "")
          ? (await import("../src/command/project-settings.ts")).runProjectSettingsCommand(rest, options)
          : (await import("../src/command/project.ts")).runProjectCommand(rest, options)),
      );
      return 0;
    }
    if (command === "access") {
      outputJson(stdout, await (await import("../src/command/access.ts")).runAccessCommand(rest, options));
      return 0;
    }
    if (command === "fleet") {
      if (rest[0] === "processes") {
        outputJson(stdout, await (await import("../src/command/agents.ts")).runAgentsCommand(rest, options));
        return 0;
      }
      if (rest[0] === "simulator") {
        outputJson(
          stdout,
          await (
            await import("../src/command/fleet-resources.ts")
          ).runSimulatorCommand(rest.slice(1), {
            ...options,
            progress: (line) => stderr.write(`${line}\n`),
          }),
        );
        return 0;
      }
      if (rest.length === 1 && rest[0] === "resources") {
        outputJson(
          stdout,
          await (await import("../src/command/fleet-resources.ts")).runResourceStatusCommand(options),
        );
        return 0;
      }
      const result = await (await import("../src/command/fleet.ts")).runFleetCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "simulator") {
      outputJson(
        stdout,
        await (
          await import("../src/command/fleet-resources.ts")
        ).runSimulatorCommand(rest, { ...options, progress: (line) => stderr.write(`${line}\n`) }),
      );
      return 0;
    }
    if (command === "herdr") {
      if (!rest.length) return await (await import("../src/session/herdr-connection.ts")).openHerdr(options);
      if (rest[0] === "help" || rest[0] === "--help") {
        stdout.write(
          "clankie herdr: open | status [--json] | use NAME | create | disable | fleets | add | remove | prepare\n",
        );
        return 0;
      }
      if (rest[0] === "status") {
        const inventory = (await import("@clankie/protocol")).MachineInventorySchema.parse(
          await (await import("../src/command/machines.ts")).runMachinesCommand([], options),
        );
        if (rest.includes("--json"))
          outputJson(stdout, {
            ...(await (await import("../src/command/herdr.ts")).runHerdrCommand(["status"], options)),
            ...inventory,
          });
        else stdout.write(`${(await import("../src/command/machines.ts")).formatMachines(inventory)}\n`);
        return 0;
      }
      if (rest[0] === "fleets") {
        const result = await (
          await import("../src/command/machines.ts")
        ).runMachinesCommand(rest.includes("--json") ? ["--json"] : [], options);
        if (rest.includes("--json")) outputJson(stdout, result);
        else
          stdout.write(
            `${(await import("../src/command/machines.ts")).formatMachines((await import("@clankie/protocol")).MachineInventorySchema.parse(result))}\n`,
          );
        return 0;
      }
      if (rest[0] === "remove" || (rest[0] === "add" && !rest.includes("--session"))) {
        outputJson(
          stdout,
          await (await import("../src/command/machines.ts")).runMachinesCommand(rest, options),
        );
        return 0;
      }
      if (rest[0] === "--connection") {
        const connectionId = rest[1];
        if (!connectionId || !/^[a-z][a-z0-9-]{0,63}$/u.test(connectionId))
          throw new Error("Select a runtime connection ID");
        const target = { ...options, connectionId };
        const args = rest.slice(2);
        if (args.length === 1 && args[0] === "open")
          return await (await import("../src/session/herdr-connection.ts")).openHerdr(target);
        if (!args.length) throw new Error("Supply a Herdr command or open");
        return await (await import("../src/session/herdr-connection.ts")).runFleetHerdr(args, target);
      }
      if (rest.length === 1 && rest[0] === "open")
        return await (await import("../src/session/herdr-connection.ts")).openHerdr(options);
      const fleetArgs = (await import("../src/command/herdr.ts")).herdrFleetRuntimeArgs(rest);
      if (fleetArgs !== undefined) {
        outputJson(stdout, {
          ...(await (await import("../src/command/runtime.ts")).runRuntimeCommand(fleetArgs, options)),
          hint: (await import("../src/command/machines.ts")).MACHINE_RESTART_HINT,
        });
        return 0;
      }
      if ((await import("../src/command/herdr.ts")).forwardsToFleetHerdr(rest))
        return await (await import("../src/session/herdr-connection.ts")).runFleetHerdr(rest, options);
      const result = await (await import("../src/command/herdr.ts")).runHerdrCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "workdir") {
      const result = await (await import("../src/command/workdir.ts")).runWorkdirCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "stance") {
      return await (await import("../src/command/stance.ts")).runStanceCommand(rest, { ...options, stdout });
    }
    if (command === "work-on") {
      return await (await import("../src/command/work-on.ts")).runWorkOnCommand(rest, { ...options, stdout });
    }
    if (command === "hire-receipt")
      return await (
        await import("../src/command/hire-receipt.ts")
      ).runHireReceiptCommand(rest, { ...options, stdout });
    if (command === "seat-delivery")
      return await (
        await import("../src/command/seat-delivery.ts")
      ).runSeatDeliveryCommand(rest, { ...options, stdout });
    // Prompt and memory card print the words themselves, not a JSON envelope:
    // the consumer is another harness's system prompt or a per-turn hook.
    if (command === "prompt") {
      return await (await import("../src/command/prompt.ts")).runPromptCommand(rest, { ...options, stdout });
    }
    if (command === "reset")
      return await (await import("../src/command/reset.ts")).runResetCommand(rest, options);
    if (command === "conversations" || command === "conversation")
      return await (await import("../src/command/conversations.ts")).runConversationsCommand(rest, options);
    if (command === "send")
      return await (await import("../src/command/send.ts")).runSendCommand(rest, { ...options, stdout });
    if (command === "file")
      return await (await import("../src/command/file.ts")).runFileCommand(rest, { ...options, stdout });
    if (command === "memory-card") {
      return await (
        await import("../src/command/memory-card.ts")
      ).runMemoryCardCommand(rest, { ...options, stdout });
    }
    if (command === "memory") {
      const result = await (await import("../src/command/memory.ts")).runMemoryCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "evaluator") {
      const result = await (await import("../src/command/evaluator.ts")).runEvaluatorCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "telemetry")
      return await (
        await import("../src/command/telemetry.ts")
      ).runTelemetryCommand(rest, { stdout, stderr });
    if (command === "metrics") {
      const result = await (await import("../src/command/metrics.ts")).runMetricsCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    // The seat: Claude Code as Clankie (ADR 0152). `mcp` is its stdio side and
    // speaks JSON-RPC on stdout, so it never goes through outputJson.
    if (command === "seat-sync")
      return await (await import("../src/command/seat-sync.ts")).runSeatSyncCommand(rest, options);
    if (command === "seat-hook")
      return await (await import("../src/command/seat-hook.ts")).runSeatHookCommand(rest, options);
    if (
      command === "seat" ||
      (await import("../src/command/harness-command.ts")).operatorHarness(command) !== undefined
    ) {
      return await (
        await import("../src/command/seat.ts")
      ).runSeatCommand(rest, {
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
      return await (await import("../src/command/mcp.ts")).runMcpCommand(rest, { ...options, stderr });
    }
    if (command === "discord") {
      const result = await (await import("../src/command/discord.ts")).runDiscordCommand(rest, options);
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
