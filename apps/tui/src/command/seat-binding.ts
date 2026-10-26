import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { OPERATOR_SEAT_BINDINGS_PATH } from "@clankie/protocol";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

/**
 * The launcher side of a seat binding (VUH-2816). The launcher spawned the
 * harness, so it is the one process that knows its pid. It registers that pid
 * and the hash of a launch nonce with the service, which proves the launcher's
 * own process from the socket. The nonce travels only in the harness's own
 * launch config for its MCP bridge, never in an environment a shell inherits.
 */
export function mintBridgeNonce(): string {
  return randomBytes(32).toString("hex");
}

/** Only MCP's own environment gets this path; harness tool children get neither value. */
export function writeBridgeNonceFile(directory: string, nonce: string): string {
  const path = join(directory, "bridge-nonce");
  writeFileSync(path, nonce, { mode: 0o600, flag: "wx" });
  return path;
}

export interface SeatBindingOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly host?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly operatorCredentialStore?: CredentialStore | undefined;
  readonly warn?: (message: string) => void;
  /** Re-registration cadence; a restarted service forgets its in-memory registry. */
  readonly intervalMs?: number;
}

export interface SeatBinding {
  /** Resolves after the first registration attempt, successful or not. */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

export function registerSeatBinding(
  input: {
    readonly conversationId: string;
    readonly harnessPid: number;
    readonly nonce: string;
    /** 2 when the launcher spawned a shell that then ran the harness. */
    readonly depth?: 1 | 2;
  },
  options: SeatBindingOptions,
): SeatBinding {
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? (() => undefined);
  const nonceHash = createHash("sha256").update(input.nonce).digest("hex");
  let warned = false;
  let stopped = false;
  const request = async (method: "PUT" | "DELETE"): Promise<Response | undefined> => {
    const credential = await resolveOperatorCredential({
      env: options.env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (credential === undefined) return undefined;
    const url = new URL(
      OPERATOR_SEAT_BINDINGS_PATH,
      commandHost({ ...(options.host === undefined ? {} : { host: options.host }), env: options.env }),
    );
    if (method === "DELETE") url.searchParams.set("conversationId", input.conversationId);
    return await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      ...(method === "PUT"
        ? {
            body: JSON.stringify({
              conversationId: input.conversationId,
              harnessPid: input.harnessPid,
              nonceHash,
              ...(input.depth === undefined ? {} : { depth: input.depth }),
            }),
          }
        : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  };
  const register = async () => {
    try {
      const response = await request("PUT");
      if (response?.ok) {
        warned = false;
        return;
      }
      if (!warned && !stopped) {
        warned = true;
        // allow-swallowed-rejection -- malformed refusal JSON still reports its HTTP status below
        const detail: unknown = await response?.json().catch(() => undefined);
        const body = typeof detail === "object" && detail !== null ? (detail as Record<string, unknown>) : {};
        const code =
          typeof body.error === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(body.error)
            ? body.error
            : undefined;
        const recovery =
          typeof body.recovery === "string"
            ? Array.from(body.recovery.replaceAll(input.nonce, "[redacted]"), (character) =>
                character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character,
              )
                .join("")
                .slice(0, 600)
            : undefined;
        warn(
          `seat binding refused (${response?.status ?? "no credential"}${code ? `: ${code}` : ""}); ${recovery ?? "its bridge stays locked out until it registers"}`,
        );
      }
    } catch (error) {
      if (!warned && !stopped) {
        warned = true;
        warn(`seat binding unavailable (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  };
  const ready = register();
  const timer = setInterval(() => void register(), options.intervalMs ?? 5_000);
  timer.unref?.();
  return {
    ready,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await ready;
      try {
        const response = await request("DELETE");
        if (!response?.ok)
          warn(
            `seat binding withdrawal refused (${response?.status ?? "no credential"}); registration may remain until its native process expires`,
          );
      } catch {
        // Keep harness exit cleanup intact; never print request errors that may contain credentials.
        warn("seat binding withdrawal unavailable; registration may remain until its native process expires");
      }
    },
  };
}

/** The launcher-facing form: register the harness it just spawned, or nothing for a joined seat. */
export function bindLaunchedHarness(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly operatorCredentialStore?: CredentialStore;
    readonly joinedSeat?: unknown;
  },
  input: {
    readonly command: string;
    readonly conversationId: string | undefined;
    readonly harnessPid: number | undefined;
    readonly nonce: string | undefined;
    readonly depth?: 1 | 2;
    readonly stderr: { write(chunk: string): unknown };
  },
): SeatBinding | undefined {
  // A joined seat reaches its home through the join channel, which proves its own process.
  if (
    options.joinedSeat !== undefined ||
    input.conversationId === undefined ||
    input.harnessPid === undefined ||
    input.nonce === undefined
  )
    return undefined;
  return registerSeatBinding(
    {
      conversationId: input.conversationId,
      harnessPid: input.harnessPid,
      nonce: input.nonce,
      ...(input.depth === undefined ? {} : { depth: input.depth }),
    },
    {
      env: options.env ?? process.env,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.operatorCredentialStore === undefined
        ? {}
        : { operatorCredentialStore: options.operatorCredentialStore }),
      warn: (message) => input.stderr.write(`clankie ${input.command}: ${message}\n`),
    },
  );
}
