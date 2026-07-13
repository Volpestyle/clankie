import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createLogger } from "@clankie/observability";
import { TerminalAccessAuthority } from "./terminal-access-authority.ts";
import { createTerminalGateway, TERMINAL_GATEWAY_PATH, type TerminalGateway } from "./terminal-gateway.ts";
import type { TerminalManager } from "./terminals.ts";

type Logger = ReturnType<typeof createLogger>;

/**
 * Dev-host-only observe token handoff. It stages a mode-0600 credential
 * descriptor that a local Mac harness relays into the iOS Simulator container.
 * The token is short-lived (<=5 min) and observe-only, and server-side validity
 * is anchored to the gateway process: on shutdown the signing secret is rotated,
 * invalidating every minted token regardless of the file. Pairing remains the
 * sole product auth path. App-side dev loading (including any Release-build
 * exclusion) is app-lead scope; this module is the writer only.
 */
export const TERMINAL_CREDENTIAL_SCHEMA_VERSION = 1 as const;
const MAX_DEV_TOKEN_TTL_MS = 300_000;
const MIN_DEV_TOKEN_TTL_MS = 1_000;
const CREDENTIAL_MODE = 0o600;

export interface TerminalGatewayCredential {
  schemaVersion: typeof TERMINAL_CREDENTIAL_SCHEMA_VERSION;
  handoffId: string;
  url: string;
  token: string;
  principalId: string;
  deviceId: string;
  expiresAt: string;
}

export interface DevHandoffConfig {
  credentialPath: string;
  principalId: string;
  deviceId: string;
  host?: string;
  port?: number;
  ttlMs?: number;
}

export interface RunningDevHandoff {
  readonly address: { host: string; port: number };
  close(): Promise<void>;
}

export class DevHandoffConfigError extends Error {}

/** Parse and validate dev-handoff configuration from a process environment. Returns null when disabled. */
export function readDevHandoffConfig(env: NodeJS.ProcessEnv): DevHandoffConfig | null {
  if (env.CLANKIE_TERMINAL_GATEWAY_ENABLED !== "1") return null;
  const credentialPath = env.CLANKIE_TERMINAL_GATEWAY_CREDENTIAL_PATH?.trim();
  const principalId = env.CLANKIE_TERMINAL_GATEWAY_PRINCIPAL_ID?.trim();
  const deviceId = env.CLANKIE_TERMINAL_GATEWAY_DEVICE_ID?.trim();
  if (!credentialPath || !principalId || !deviceId) {
    throw new DevHandoffConfigError("gateway_config_incomplete");
  }
  const host = env.CLANKIE_TERMINAL_GATEWAY_HOST?.trim();
  const portText = env.CLANKIE_TERMINAL_GATEWAY_PORT?.trim();
  const port = portText ? Number(portText) : undefined;
  if (portText && !Number.isInteger(port)) throw new DevHandoffConfigError("gateway_port_invalid");
  return {
    credentialPath,
    principalId,
    deviceId,
    ...(host ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
  };
}

/**
 * Bind the observe-only gateway and stage the dev credential. The returned
 * handle closes idempotently: it drains the gateway, rotates the authority
 * (invalidating tokens server-side), then nonce-matched cleans the credential.
 */
export async function startTerminalGatewayDevHandoff(options: {
  manager: TerminalManager;
  config: DevHandoffConfig;
  logger?: Logger;
}): Promise<RunningDevHandoff> {
  const logger =
    options.logger ?? createLogger({ service: "clankie-runner-terminal-gateway", version: "0.1.0" });
  const ttlMs = Math.min(options.config.ttlMs ?? MAX_DEV_TOKEN_TTL_MS, MAX_DEV_TOKEN_TTL_MS);
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_DEV_TOKEN_TTL_MS) {
    throw new DevHandoffConfigError("gateway_ttl_invalid");
  }
  const authority = new TerminalAccessAuthority();
  let gateway: TerminalGateway | undefined;
  try {
    gateway = await createTerminalGateway({
      manager: options.manager,
      authority,
      config: {
        ...(options.config.host ? { host: options.config.host } : {}),
        ...(options.config.port !== undefined ? { port: options.config.port } : {}),
      },
      logger,
    });
    const handoffId = randomUUID();
    const token = authority.mintObserveToken({
      principalId: options.config.principalId,
      deviceId: options.config.deviceId,
      ttlMs,
    });
    const credential: TerminalGatewayCredential = {
      schemaVersion: TERMINAL_CREDENTIAL_SCHEMA_VERSION,
      handoffId,
      url: `ws://${gateway.address.host}:${gateway.address.port}${TERMINAL_GATEWAY_PATH}`,
      token,
      principalId: options.config.principalId,
      deviceId: options.config.deviceId,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    await writeTerminalGatewayCredential(options.config.credentialPath, credential);
    logger.info(
      { event: "terminal.gateway.handoff.staged", host: gateway.address.host, port: gateway.address.port },
      "observe-only terminal gateway dev credential staged",
    );
    const boundGateway = gateway;
    let closing: Promise<void> | undefined;
    return {
      address: boundGateway.address,
      close() {
        if (!closing) {
          closing = (async () => {
            try {
              await boundGateway.close();
            } finally {
              authority.invalidate();
              await removeTerminalGatewayCredential(options.config.credentialPath, handoffId);
            }
          })();
        }
        return closing;
      },
    };
  } catch (error) {
    try {
      if (gateway) await gateway.close();
    } finally {
      authority.invalidate();
    }
    throw error;
  }
}

/** Atomically stage a credential with mode 0600 using no-follow exclusive creation of a temp file. */
export async function writeTerminalGatewayCredential(
  path: string,
  credential: TerminalGatewayCredential,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  // "wx" is O_CREAT|O_EXCL|O_WRONLY: it never follows or clobbers an existing path.
  const handle = await open(temporary, "wx", CREDENTIAL_MODE);
  try {
    try {
      await handle.chmod(CREDENTIAL_MODE);
      await handle.writeFile(`${JSON.stringify(credential)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    // Never strand a token: remove the temp on any staging failure.
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Remove the credential only when the final path component is a regular
 * mode-0600 file (opened without following symlinks) carrying this handoff id.
 */
export async function removeTerminalGatewayCredential(path: string, handoffId: string): Promise<void> {
  const claimed = join(dirname(path), `.${basename(path)}.${randomUUID()}.cleanup`);
  try {
    await rename(path, claimed);
  } catch {
    return;
  }
  let handle;
  try {
    handle = await open(claimed, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    await restoreClaimedCredential(claimed, path);
    return;
  }
  let match = false;
  try {
    const stat = await handle.stat();
    if (stat.isFile() && (stat.mode & 0o777) === CREDENTIAL_MODE) {
      const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<TerminalGatewayCredential>;
      match = parsed.handoffId === handoffId;
    }
  } catch {
    match = false;
  } finally {
    await handle.close();
  }
  if (match) await rm(claimed, { force: true });
  else await restoreClaimedCredential(claimed, path);
}

/** Restore a non-matching atomically claimed file without overwriting any replacement. */
async function restoreClaimedCredential(claimed: string, path: string): Promise<void> {
  try {
    const stat = await lstat(claimed);
    if (stat.isSymbolicLink()) await symlink(await readlink(claimed), path);
    else await link(claimed, path);
    await rm(claimed, { force: true });
  } catch {
    // A replacement now occupies the configured path. Preserve the claimed file
    // under its unique cleanup name rather than deleting either credential.
  }
}

/**
 * Install an idempotent, awaited signal shutdown for the handoff on the given
 * process-like emitter. The first SIGINT/SIGTERM drains the gateway, cleans the
 * credential, then exits; repeated signals do not start competing cleanup, and a
 * stalled graceful close is bounded by a forced exit.
 */
export function installDevHandoffShutdown(
  handoff: RunningDevHandoff,
  options: {
    processLike?: Pick<EventEmitter, "once"> & { exit(code?: number): void };
    logger?: Logger;
    forcedExitMs?: number;
    setTimer?: (callback: () => void, ms: number) => { unref?: () => void };
    clearTimer?: (timer: { unref?: () => void }) => void;
  } = {},
): void {
  const proc = options.processLike ?? process;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  const forcedExitMs = options.forcedExitMs ?? 5_000;
  let shuttingDown = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const exitCode = signal === "SIGINT" ? 130 : 143;
    const forced = setTimer(() => proc.exit(exitCode), forcedExitMs);
    forced.unref?.();
    void handoff
      .close()
      .catch(() => {
        options.logger?.error(
          { event: "terminal.gateway.shutdown", reason: "close_failed" },
          "terminal gateway shutdown close failed",
        );
      })
      .finally(() => {
        clearTimer(forced);
        proc.exit(exitCode);
      });
  };
  proc.once("SIGINT", () => shutdown("SIGINT"));
  proc.once("SIGTERM", () => shutdown("SIGTERM"));
}
