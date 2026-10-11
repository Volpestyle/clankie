import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { HerdrBinding } from "@clankie/protocol";
import { preparePaneShell } from "../../../integrations/herdr-plugin/claude-path-shim.mjs";

export function localClaudeShimPaths(binding: HerdrBinding, env: NodeJS.ProcessEnv = process.env) {
  return binding.runtime === "bundled"
    ? {
        root: dirname(binding.socketPath),
        configPath: join(dirname(binding.socketPath), "herdr/config.toml"),
      }
    : {
        root: join(
          env.CLANKIE_STATE?.trim() || join(env.HOME || homedir(), ".clankie"),
          "herdr-pane",
          binding.session,
        ),
        configPath: join(dirname(binding.socketPath), "config.toml"),
      };
}

/** Reload affects future panes only: never restart or steer existing occupants. */
export async function prepareLocalClaudeShim(
  action: "install" | "remove",
  binding: HerdrBinding,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (binding.runtime === "bundled")
    throw new Error(
      "Bundled zsh panes are prepared at service start; removal is only for an external session.",
    );
  const paths = localClaudeShimPaths(binding, env);
  const result = await preparePaneShell({ ...paths, socketPath: binding.socketPath, owner: env, action });
  try {
    await promisify(execFile)("herdr", ["server", "reload-config"], {
      env: { ...env, HERDR_SOCKET_PATH: binding.socketPath },
      timeout: 10_000,
    });
  } catch (error) {
    throw new Error(
      `Herdr shell configuration saved at ${result.canonical}, but reload failed: ${error instanceof Error ? error.message : String(error)}. Inspect before retrying; no existing pane was changed.`,
    );
  }
  return result;
}
