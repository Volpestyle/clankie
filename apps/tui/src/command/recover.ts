import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { updateHoldingServices } from "../../bin/runtime-updater.ts";
import { recoverServices, type RecoveryOptions, type RecoveryPass } from "../../bin/service-recovery.ts";
import { createServiceOptions, restartTarget, type CreateServiceOptionsInput } from "../../bin/services.ts";
import { clankieStateHome } from "../state-home.ts";
import { outputJson } from "./io.ts";

const RECOVER_USAGE = "Usage: clankie recover [--autostart]";

export interface RecoverCommandOptions extends CreateServiceOptionsInput {
  readonly stdout?: { write(chunk: string): unknown };
  /** Test seam: this boot's identity. */
  readonly bootId?: () => string | undefined;
  readonly recovery?: RecoveryOptions;
}

/**
 * This boot's identity, so the autostart tick can tell its first run after a
 * boot (start Clankie, as the login agent always did) from every later tick
 * (only restart what crashed).
 */
export function currentBootId(): string | undefined {
  try {
    if (process.platform === "darwin") {
      const raw = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 2_000,
      });
      return /sec = (\d+)/u.exec(raw)?.[1];
    }
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function bootMarkerPath(env: NodeJS.ProcessEnv): string {
  return join(clankieStateHome(env), "clankie", "autostart-boot.json");
}

function readBootMarker(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const value = JSON.parse(readFileSync(bootMarkerPath(env), "utf8")) as { boot?: unknown };
    return typeof value.boot === "string" ? value.boot : undefined;
  } catch {
    return undefined;
  }
}

function writeBootMarker(env: NodeJS.ProcessEnv, boot: string): void {
  const path = bootMarkerPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ boot, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

/**
 * `clankie recover`: one crash-recovery pass. `--autostart` is what the login
 * agent runs every 30 seconds; its first run after a boot starts Clankie the
 * way the one-shot login agent did, and every later run only restarts what
 * crashed.
 */
export async function runRecoverCommand(
  args: readonly string[],
  options: RecoverCommandOptions,
): Promise<number> {
  const autostart = args.length === 1 && args[0] === "--autostart";
  if (args.length > 1 || (args.length === 1 && !autostart)) throw new Error(RECOVER_USAGE);
  const env = options.env ?? process.env;
  const out = options.stdout ?? process.stdout;
  const registry = await createServiceOptions(options);

  if (autostart) {
    const boot = (options.bootId ?? currentBootId)();
    if (boot !== undefined && readBootMarker(env) !== boot) {
      // Record the boot first: a start that fails here must not be retried
      // every 30 seconds as a fresh login.
      writeBootMarker(env, boot);
      if (updateHoldingServices(env) !== undefined) {
        outputJson(out, { ok: true, status: "skipped", reason: "update", boot });
        return 0;
      }
      const outcomes = await restartTarget("clankie", registry);
      const ok = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
      outputJson(out, { ok, status: ok ? "started" : "failed", boot, services: outcomes });
      return ok ? 0 : 1;
    }
  }

  const pass: RecoveryPass = await recoverServices(registry, options.recovery);
  const failed = pass.actions.some((action) => action.action === "failed");
  outputJson(out, {
    ...pass,
    status: pass.skipped ?? (pass.actions.length === 0 ? "nothing_to_recover" : "recovered"),
  });
  return failed ? 1 : 0;
}
