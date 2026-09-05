import { openHerdr } from "../src/session/herdr-connection.ts";
import { type CredentialStore } from "@clankie/credential-broker";
import { type ServiceRegistryOptions } from "./services.ts";
import { doctorCommand, type ExecFileImpl } from "../src/command/doctor.ts";
import { statusCommand } from "../src/command/status.ts";
import { runModelCommand } from "../src/command/model.ts";
import { runPersonaCommand } from "../src/command/persona.ts";
import { runGamesCommand } from "../src/command/games.ts";
import { runHerdrCommand } from "../src/command/herdr.ts";
import { runWorkdirCommand } from "../src/command/workdir.ts";
import { runEffortCommand } from "../src/command/effort.ts";
import { runImageModelCommand } from "../src/command/image-model.ts";
import { runVideoModelCommand } from "../src/command/video-model.ts";
import { runDiscordCommand } from "../src/command/discord.ts";
import { runRestartCommand, runDownCommand } from "../src/command/restart.ts";
import { runPairCommand } from "../src/command/pair.ts";
import { runDevicesCommand } from "../src/command/devices.ts";
import { runPlayCommand } from "../src/command/play.ts";
import { runStanceCommand } from "../src/command/stance.ts";
import { runPromptCommand } from "../src/command/prompt.ts";
import { runMemoryCardCommand } from "../src/command/memory-card.ts";
import { runMemoryCommand } from "../src/command/memory.ts";
import { runSeatCommand } from "../src/command/seat.ts";
import { runMcpCommand } from "../src/command/mcp.ts";
import { runOperatorCredentialCommand } from "../src/command/operator-credential.ts";
import { runGatewayCommand } from "../src/command/gateway.ts";
import { runAutostartCommand } from "../src/command/autostart.ts";
import { commandHelp } from "../src/command/registry.ts";
import { outputJson, type Writable } from "../src/command/io.ts";

export { isHeadlessCaptainCommand } from "../src/command/registry.ts";

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
    if (command === "health" || command === "status") {
      const result = await statusCommand(options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    if (command === "doctor") {
      const result = await doctorCommand({
        repoRoot: options.repoRoot,
        env: options.env ?? process.env,
        ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
      });
      outputJson(stdout, result);
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
    if (command === "pair") return await runPairCommand(rest, options);
    if (command === "devices") return await runDevicesCommand(rest, options);
    if (command === "operator-credential") return await runOperatorCredentialCommand(rest, options);
    if (command === "gateway") {
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
    if (command === "games") {
      const result = await runGamesCommand(rest, options);
      outputJson(stdout, result);
      return 0;
    }
    if (command === "herdr") {
      if (rest.length === 1 && rest[0] === "open") return await openHerdr(options);
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
    // Prompt and memory card print the words themselves, not a JSON envelope:
    // the consumer is another harness's system prompt or a per-turn hook.
    if (command === "prompt") {
      return await runPromptCommand(rest, { ...options, stdout });
    }
    if (command === "memory-card") {
      return await runMemoryCardCommand(rest, { ...options, stdout });
    }
    if (command === "memory") {
      const result = await runMemoryCommand(rest, options);
      outputJson(stdout, result);
      return result.ok ? 0 : 1;
    }
    // The seat: Claude Code as Clankie (ADR 0152). `mcp` is its stdio side and
    // speaks JSON-RPC on stdout, so it never goes through outputJson.
    if (command === "seat") {
      return await runSeatCommand(rest, {
        repoRoot: options.repoRoot,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.execFileImpl === undefined ? {} : { execFileImpl: options.execFileImpl }),
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
