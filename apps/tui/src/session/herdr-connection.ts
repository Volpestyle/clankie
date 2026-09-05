import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { HerdrBindingSchema, type HerdrBinding } from "@clankie/protocol";

export interface HerdrConnectionOptions {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

export async function readHerdrBinding(options: HerdrConnectionOptions): Promise<HerdrBinding> {
  const env = options.env ?? process.env;
  const host =
    options.host ?? env.CLANKIE_CONTROL_PLANE_URL ?? env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4310";
  // A Unix socket belongs to this machine. Remote terminal transport is a separate API.
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(host).hostname)) {
    throw new Error("Herdr's native viewer requires a local Clankie service");
  }
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Clankie's operator credential is unavailable");
  return new ClankieApiClient({
    baseUrl: host,
    operatorToken: credential.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }).getHerdrBinding();
}

/** Route every native fleet action using the running service, never pending settings. */
export function herdrConnection(binding: HerdrBinding, options: HerdrConnectionOptions) {
  HerdrBindingSchema.parse(binding);
  const caller = options.env ?? process.env;
  const env = { ...caller };
  for (const name of Object.keys(env))
    if (name.startsWith("HERDR_") || name.startsWith("HERD_LEAD_")) delete env[name];
  env.HERDR_SOCKET_PATH = binding.socketPath;
  if (caller.HERDR_SOCKET_PATH === binding.socketPath) {
    for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) {
      if (caller[name]) env[name] = caller[name];
    }
  }
  let command = "herdr";
  if (binding.runtime === "bundled") {
    command = join(
      options.repoRoot,
      existsSync(join(options.repoRoot, "release.json")) ? "libexec/herdr" : ".data/herdr/bin/herdr",
    );
    const root = dirname(binding.socketPath);
    env.XDG_CONFIG_HOME = root;
    env.XDG_STATE_HOME = root;
    env.XDG_RUNTIME_DIR = root;
    env.HERDR_PLUGIN_STATE_DIR = join(root, "herdr/plugins/herd-lead");
    env.PATH = `${dirname(command)}${delimiter}${env.PATH ?? ""}`;
  }
  return { command, env };
}

/** Attach only: `client` cannot start or stop the service's Herdr server. */
export async function openHerdr(options: HerdrConnectionOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The Herdr viewer requires a TTY");
  const { command, env } = herdrConnection(await readHerdrBinding(options), options);
  // Explicitly opening a viewer may nest it in another terminal UI; no caller pane identity applies.
  for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) delete env[name];
  const interrupted = () => {}; // The foreground viewer receives the terminal's SIGINT too.
  process.on("SIGINT", interrupted);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, ["client"], { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupted);
  }
}
