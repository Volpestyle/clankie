import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  herdrConnection,
  readHerdrBinding,
  type HerdrConnectionOptions,
} from "../session/herdr-connection.ts";
import {
  openCodeServicePath,
  readOpenCodeService,
} from "../../../clankie/src/captain/opencode-shared-service.ts";

// `clankie harness opencode` (ADR 0337): messages to OpenCode 2 sessions the
// owner opened by hand. Herdr's own OpenCode integration reports each pane's
// session to Herdr; Clankie then admits a message into that session's inbox on
// OpenCode's shared service. `install` runs `herdr integration install opencode`,
// which adds Herdr's plugin to the owner's OpenCode settings, and nothing else.

const USAGE = "Usage: clankie harness opencode [status|install]";

export interface OpenCodeMessagingStatus {
  readonly ok: true;
  /** The OpenCode settings folder Herdr's integration writes to. */
  readonly configDir: string;
  /** Herdr's plugin for OpenCode 2 TUIs is in place and listed in `cli.json`. */
  readonly herdrPlugin: boolean;
  /** OpenCode 2's shared service is registered and running. */
  readonly sharedService: boolean;
  /** Both hold: a hand-opened OpenCode 2 session in a Herdr pane can take a message. */
  readonly messageable: boolean;
  readonly next?: string;
  /** What `install` did, when it ran. */
  readonly installed?: string;
}

/** `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, as Herdr resolves it. */
export function openCodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(xdg, "opencode");
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Reads only whether Herdr's entries are present; no settings value leaves this function. */
export async function inspectOpenCodeMessaging(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenCodeMessagingStatus> {
  const configDir = openCodeConfigDir(env);
  const cli = await readFile(join(configDir, "cli.json"), "utf8").catch(() => "");
  const herdrPlugin =
    cli.includes('"./herdr-opencode"') && (await exists(join(configDir, "herdr-opencode", "tui.js")));
  const sharedService = (await readOpenCodeService(openCodeServicePath(env))) !== undefined;
  const messageable = herdrPlugin && sharedService;
  const legacy =
    (await exists(join(configDir, "tui.json"))) ||
    (await exists(
      join(
        env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state"),
        "opencode",
        "kv.json",
      ),
    ));
  const next = !herdrPlugin
    ? cli === "" && legacy
      ? "Start opencode once so it moves your settings to OpenCode 2, then run `clankie harness opencode install`."
      : "Run `clankie harness opencode install` to add Herdr's plugin to your OpenCode settings."
    : !sharedService
      ? "Open opencode once; OpenCode 2 starts its shared service then, and Clankie reaches your sessions through it."
      : undefined;
  return {
    ok: true,
    configDir,
    herdrPlugin,
    sharedService,
    messageable,
    ...(next === undefined ? {} : { next }),
  };
}

export async function runHarnessOpenCodeCommand(
  args: readonly string[],
  options: HerdrConnectionOptions & {
    /** Runs the Herdr command; a test may stand in for the binary. */
    readonly herdr?: (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
  },
): Promise<OpenCodeMessagingStatus> {
  const verb = args[0] ?? "status";
  if (args.length > 1 || (verb !== "status" && verb !== "install")) throw new Error(USAGE);
  const env = options.env ?? process.env;
  if (verb === "status") return inspectOpenCodeMessaging(env);
  // Herdr refuses a missing OpenCode settings folder ("install opencode first").
  await mkdir(openCodeConfigDir(env), { recursive: true });
  const { command, env: herdrEnv } = herdrConnection(await readHerdrBinding(options), options);
  const run =
    options.herdr ??
    (async (file: string, argv: readonly string[], childEnv: NodeJS.ProcessEnv) =>
      (await promisify(execFile)(file, [...argv], { env: childEnv, timeout: 30_000 })).stdout);
  const output = await run(command, ["integration", "install", "opencode"], herdrEnv);
  return { ...(await inspectOpenCodeMessaging(env)), installed: output.trim().split("\n").at(-1) ?? "" };
}
