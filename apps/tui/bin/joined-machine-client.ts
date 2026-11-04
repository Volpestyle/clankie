/** Outbound-only public join host. Gateway deployment/routing is an ops responsibility. */
import { randomBytes, randomUUID } from "node:crypto";
import { openGatewayValue, sealGatewayValue } from "../../clankie/src/gateway-encryption.ts";
import { machineJoinKey } from "../../clankie/src/machine-join-crypto.ts";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import type { CredentialStore } from "@clankie/credential-broker";
import { machineAccessAllows } from "@clankie/protocol";
import { joinedScreenRecovery } from "@clankie/interactive-environment";
import {
  MACHINE_JOIN_OUTPUT_CHAR_MAX,
  MACHINE_JOIN_SCREEN_OUTPUT_CHAR_MAX,
  MACHINE_JOIN_RESULT_BATCH_BYTES_MAX,
  MACHINE_JOIN_CHANNEL_PATH,
  MACHINE_JOIN_CHALLENGE_PATH,
  MachineJoinChallengeSchema,
  MachineJoinPayloadSchema,
  MachineJoinRevokedSchema,
  machineJoinExchangeAad,
  MACHINE_JOIN_LEAVE_PATH,
  JoinedMachineBatchSchema,
  MachineJoinLeaseSchema,
  JoinedMachineRequestSchema,
  JoinedMachineResourceResultSchema,
  type JoinedMachineResourceRequest,
  type JoinedMachineResourceResult,
  type JoinedMachinePolicy,
  type JoinedMachineRequest,
  type JoinedMachineResult,
  type JoinedSeatRequest,
} from "@clankie/protocol/machine-join";

const JOINED_MACHINE_CREDENTIAL = "clankie-joined-machine";
const JOINED_MACHINE_REVOCATION = "clankie-joined-machine-revoked";
const JoinedMachineCredentialSchema = z
  .object({
    origin: z.string().url(),
    lease: MachineJoinLeaseSchema,
    localDirectories: z.array(z.string().min(1).max(4096)).max(32),
  })
  .strict();
export type JoinedMachineCredential = z.infer<typeof JoinedMachineCredentialSchema>;

/** TLS protects the carrier; machine envelopes independently authenticate the body. */
export function machineJoinOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
  )
    throw Error("join_origin_refused");
  return url.href.replace(/\/$/u, "");
}
export async function readJoinedMachineCredential(
  store: CredentialStore,
  options: { allowRevoked?: boolean } = {},
): Promise<JoinedMachineCredential | undefined> {
  const value = await store.get(JOINED_MACHINE_CREDENTIAL);
  if (!value) {
    if (!options.allowRevoked && (await store.get(JOINED_MACHINE_REVOCATION)))
      throw new JoinedMachineRevoked(
        "Joined machine access revoked; use clankie join leave before joining again.",
      );
    return undefined;
  }
  if (value.type !== "api") throw Error("join_credential_invalid");
  const credential = JoinedMachineCredentialSchema.parse(JSON.parse(value.key));
  machineJoinOrigin(credential.origin);
  return credential;
}
export async function saveJoinedMachineCredential(
  store: CredentialStore,
  value: JoinedMachineCredential,
): Promise<void> {
  const credential = JoinedMachineCredentialSchema.parse(value);
  machineJoinOrigin(credential.origin);
  if (!store.updateMany) throw Error("join_credential_atomic_update_unavailable");
  await store.updateMany([JOINED_MACHINE_CREDENTIAL, JOINED_MACHINE_REVOCATION], async () => ({
    [JOINED_MACHINE_CREDENTIAL]: { type: "api", key: JSON.stringify(credential) },
    [JOINED_MACHINE_REVOCATION]: undefined,
  }));
}
export interface JoinedMachinePorts {
  resources?: (
    request: JoinedMachineResourceRequest,
    signal: AbortSignal,
    guard: () => void,
  ) => Promise<JoinedMachineResourceResult>;
  closeResources?: () => Promise<void>;
  workers?: (request: string, directory: string, signal: AbortSignal) => Promise<string>;
  shell?: (command: string, directory: string, signal: AbortSignal) => Promise<string>;
  screen?: (request: string, signal: AbortSignal, guard: () => void) => Promise<string>;
  screenPolicy?: (allowed: boolean) => void;
  closeScreen?: () => Promise<void>;
  /** Only the joining machine's owned stdin/parent can call these, never the remote screen wire. */
  localScreen?: (action: "screen_status" | "screen_stop") => Promise<unknown>;
}
/** Never expose a general shell through a workers-level handler. */
async function executeJoinedMachineRequest(
  raw: JoinedMachineRequest,
  policy: JoinedMachinePolicy,
  localDirectories: readonly string[],
  approvedDirectories: readonly string[],
  ports: JoinedMachinePorts,
  signal: AbortSignal,
  operationGuard: () => void,
  originallyScreen: boolean,
): Promise<JoinedMachineResult> {
  const request = JoinedMachineRequestSchema.parse(raw);
  const operation = request.operation;
  if (signal.aborted) return { id: request.id, ok: false, error: "revoked" };
  if (
    !machineAccessAllows(policy.accessLevel, operation.kind === "resources" ? "workers" : operation.kind) &&
    !(originallyScreen && operation.kind === "screen" && joinedScreenRecovery(operation.request))
  )
    return { id: request.id, ok: false, error: "machine_access_refused" };
  let directory = "";
  if (operation.kind === "shell" || operation.kind === "workers") {
    if (!isAbsolute(operation.directory)) return { id: request.id, ok: false, error: "directory_refused" };
    try {
      directory = await realpath(operation.directory);
      const within = async (roots: readonly string[]) => {
        for (const root of roots) {
          const canonical = await realpath(root);
          const remainder = relative(canonical, directory);
          if (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`)) return true;
        }
        return false;
      };
      if (
        !(await within(localDirectories)) ||
        !(await within(approvedDirectories)) ||
        !(await within(policy.directories))
      )
        return { id: request.id, ok: false, error: "directory_refused" };
    } catch {
      return { id: request.id, ok: false, error: "directory_refused" };
    }
  }
  try {
    if (signal.aborted) return { id: request.id, ok: false, error: "revoked" };
    if (operation.kind === "resources") {
      if (!ports.resources) return { id: request.id, ok: false, error: "operation_unavailable" };
      const resources = JoinedMachineResourceResultSchema.parse(
        await ports.resources(operation.request, signal, operationGuard),
      );
      operationGuard();
      if (Buffer.byteLength(JSON.stringify(resources), "utf8") > MACHINE_JOIN_RESULT_BATCH_BYTES_MAX - 1024)
        throw Error("resource_result_too_large");
      return { id: request.id, ok: true, resources };
    }
    const handler = ports[operation.kind];
    if (!handler) return { id: request.id, ok: false, error: "operation_unavailable" };
    const output =
      operation.kind === "screen"
        ? await ports.screen!(operation.request, signal, operationGuard)
        : operation.kind === "shell"
          ? await ports.shell!(operation.command, directory, signal)
          : await ports.workers!(operation.request, directory, signal);
    if (operation.kind === "screen") {
      if (output.length > MACHINE_JOIN_SCREEN_OUTPUT_CHAR_MAX) throw Error("screen_result_too_large");
      return signal.aborted
        ? { id: request.id, ok: false, error: "revoked" }
        : { id: request.id, ok: true, screenOutput: output };
    }
    return signal.aborted
      ? { id: request.id, ok: false, error: "revoked" }
      : {
          id: request.id,
          ok: true,
          output: output.slice(0, MACHINE_JOIN_OUTPUT_CHAR_MAX),
          truncated: output.length > MACHINE_JOIN_OUTPUT_CHAR_MAX,
        };
  } catch {
    return { id: request.id, ok: false, error: signal.aborted ? "revoked" : "operation_failed" };
  }
}
/**
 * The receiver's own shell. The command runs in its own process group (a process
 * tree on Windows), so revocation, the time limit and an output overflow stop
 * everything it started. On POSIX anything still in the group when the shell
 * exits is stopped too. Known limits: a process that leaves its group (setsid, a
 * daemon) escapes, and on Windows children still running after the shell exits
 * are not stopped (no Job Object).
 * The first line is always the receiver's own `[exit N]` or `[stopped …]`, so
 * truncation cannot drop it and command output cannot forge it.
 */
export function createJoinedMachineShell(timeoutMs = 30_000): NonNullable<JoinedMachinePorts["shell"]> {
  return (command, directory, signal) =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(Error("revoked"));
      const windows = process.platform === "win32";
      const child = spawn(
        windows ? "powershell.exe" : "/bin/sh",
        windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command],
        { cwd: directory, detached: !windows, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "",
        stderr = "",
        bytes = 0,
        stopped: string | undefined,
        exited: string | undefined,
        done = false;
      const killGroup = () => {
        if (child.pid === undefined) return;
        try {
          if (windows)
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            });
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already gone.
        }
      };
      const stop = (reason?: string) => {
        stopped ??= reason;
        killGroup();
      };
      const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65_536) return stop("stopped after 64 KiB of output");
        if (stream === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };
      child.stdout!.on("data", collect("stdout"));
      child.stderr!.on("data", collect("stderr"));
      const timer = setTimeout(() => stop(`stopped after ${timeoutMs / 1000} seconds`), timeoutMs);
      const abort = () => stop();
      signal.addEventListener("abort", abort, { once: true });
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        // POSIX: leftovers in the command's group do not outlive it. Windows has no
        // tree to find once the shell has exited, and its PID may already be reused.
        if (!windows) killGroup();
        if (error) return reject(error);
        if (signal.aborted) return reject(Error("revoked"));
        const printed = stderr
          ? stdout + (stdout && !stdout.endsWith("\n") ? "\n" : "") + `[stderr]\n${stderr}`
          : stdout;
        resolve(`[${stopped ?? exited ?? "exit unknown"}]\n${printed}`);
      };
      child.on("error", (error) => finish(error));
      child.on("exit", (code, killedBy) => {
        exited = code === null ? `stopped by ${killedBy ?? "signal"}` : `exit ${code}`;
        // Let buffered output arrive; a background child holding the pipes is stopped.
        setTimeout(() => finish(), 200).unref();
      });
      child.on("close", () => finish());
    });
}
export const joinedMachineShell = createJoinedMachineShell();

class JoinedMachineRevoked extends Error {}
const localChannels = new Map<string, Set<AbortController>>();
/** A fresh one-use challenge binds each encrypted request and independently keyed response. */
export async function exchangeJoinedMachine(
  credential: JoinedMachineCredential,
  input:
    | { op: "poll" | "leave"; results: JoinedMachineResult[] }
    | { op: "seat"; request: JoinedSeatRequest },
  fetcher: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<unknown> {
  const origin = machineJoinOrigin(credential.origin);
  const post = async (path: string, body: unknown) => {
    const response = await fetcher(origin + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    const value = await response.json();
    if (!response.ok) throw Error("join_channel_unavailable");
    return value;
  };
  const { challenge } = MachineJoinChallengeSchema.parse(
    await post(MACHINE_JOIN_CHALLENGE_PATH, { machineId: credential.lease.machineId }),
  );
  const requestId = randomUUID(),
    responseSecret = randomBytes(32).toString("base64url");
  const aad = (direction: "request" | "response") =>
    machineJoinExchangeAad(direction, credential.lease.machineId, requestId, challenge);
  const payload = MachineJoinPayloadSchema.parse({ ...input, responseSecret });
  const response = z
    .object({ sealedResponse: z.string().max(1_500_000) })
    .strict()
    .parse(
      await post(input.op === "leave" ? MACHINE_JOIN_LEAVE_PATH : MACHINE_JOIN_CHANNEL_PATH, {
        machineId: credential.lease.machineId,
        challenge,
        requestId,
        sealedRequest: sealGatewayValue(
          machineJoinKey(credential.lease.token),
          JSON.stringify(payload),
          aad("request"),
        ),
      }),
    );
  const result: unknown = JSON.parse(
    openGatewayValue(machineJoinKey(responseSecret), response.sealedResponse, aad("response")),
  );
  if (MachineJoinRevokedSchema.safeParse(result).success) throw new JoinedMachineRevoked("revoked");
  return result;
}

/**
 * Claims are one-shot: a claim lost with its response expires at the home and is
 * never replayed. A failed poll carries no operation, so the channel reconnects
 * with backoff after a home restart, network loss or an unreadable response.
 * Revocation, a foreign identity or a duplicate request ends it.
 */
export async function runJoinedMachineChannel(
  credential: JoinedMachineCredential,
  options: {
    store: CredentialStore;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    ports?: JoinedMachinePorts;
    intervalMs?: number;
    /** First retry delay; doubles per failed poll up to 30 seconds. */
    retryMs?: number;
    onConnected?: () => void;
    /** Once per outage, and again when the home answers. */
    onDisconnected?: () => void;
    onReconnected?: () => void;
  },
): Promise<"left" | "revoked"> {
  machineJoinOrigin(credential.origin);
  const localStop = new AbortController();
  const signal = AbortSignal.any([options.signal, localStop.signal]);
  const channels = localChannels.get(credential.lease.token) ?? new Set<AbortController>();
  channels.add(localStop);
  localChannels.set(credential.lease.token, channels);
  const credentialCurrent = async () => {
    const current = await readJoinedMachineCredential(options.store, { allowRevoked: true });
    if (current?.lease.token !== credential.lease.token) {
      localStop.abort();
      return false;
    }
    return !signal.aborted;
  };
  const active = new Map<string, { request: JoinedMachineRequest; abort: AbortController }>();
  let results: JoinedMachineResult[] = [];
  const fetcher = options.fetchImpl ?? fetch;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  let retryMs = 0;
  let connected = false;
  let currentScreen = false;
  let currentWorkers = false;
  let policyAt = 0;
  let resourcePolicyAt = 0;
  const ports = options.ports ?? { shell: joinedMachineShell };
  const freshScreen = () => !signal.aborted && currentScreen && performance.now() - policyAt < 2000;
  const staleTimer = setInterval(() => {
    ports.screenPolicy?.(freshScreen());
    if (performance.now() - resourcePolicyAt >= 2000)
      for (const task of active.values()) if (task.request.operation.kind === "resources") task.abort.abort();
    // Observe a separate "join leave" even during a network timeout or backoff.
    void credentialCurrent().catch(() => localStop.abort());
  }, 250);
  try {
    while (await credentialCurrent()) {
      const outgoing: JoinedMachineResult[] = [];
      let bytes = 0;
      while (results.length && outgoing.length < 16) {
        const next = results[0]!;
        const size = Buffer.byteLength(JSON.stringify(next), "utf8") + 1;
        if (bytes + size > MACHINE_JOIN_RESULT_BATCH_BYTES_MAX) break;
        bytes += size;
        outgoing.push(results.shift()!);
      }
      let batch;
      try {
        batch = JoinedMachineBatchSchema.parse(
          await exchangeJoinedMachine(
            credential,
            { op: "poll", results: outgoing },
            fetcher,
            AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          ),
        );
      } catch (error) {
        if (!(error instanceof JoinedMachineRevoked)) {
          if (signal.aborted) throw error;
          resourcePolicyAt = 0;
          // Resent results settle at most once at the home; unknown ones are ignored.
          results = [...outgoing, ...results];
          if (retryMs === 0) options.onDisconnected?.();
          retryMs = Math.min(retryMs === 0 ? (options.retryMs ?? 1000) : retryMs * 2, 30_000);
          await pause(retryMs);
          continue;
        }
        // Erase the lease, but retain a secret-free refusal until explicit leave
        // or rejoin. An absent lease must not fall back to a local operator.
        if (!options.store.updateMany) throw Error("join_credential_atomic_update_unavailable");
        await options.store.updateMany(
          [JOINED_MACHINE_REVOCATION, JOINED_MACHINE_CREDENTIAL],
          async (current) => {
            // Explicit leave or a new join wins a race with an old channel response.
            const saved = current[JOINED_MACHINE_CREDENTIAL];
            if (saved?.type !== "api" || saved.key !== JSON.stringify(credential)) return current;
            return {
              [JOINED_MACHINE_CREDENTIAL]: undefined,
              [JOINED_MACHINE_REVOCATION]: { type: "api", key: "revoked" },
            };
          },
        );
        return "revoked";
      }
      if (!(await credentialCurrent())) break;
      if (batch.policy.machineId !== credential.lease.machineId) throw Error("join_identity_refused");
      if (retryMs !== 0) {
        retryMs = 0;
        options.onReconnected?.();
      }
      const policy = {
        ...batch.policy,
        accessLevel: machineAccessAllows(credential.lease.accessLevel, batch.policy.accessLevel)
          ? batch.policy.accessLevel
          : credential.lease.accessLevel,
      };
      policyAt = performance.now();
      resourcePolicyAt = policyAt;
      currentScreen = policy.accessLevel === "screen";
      currentWorkers = machineAccessAllows(policy.accessLevel, "workers");
      ports.screenPolicy?.(freshScreen());
      for (const task of active.values())
        if (
          !machineAccessAllows(
            policy.accessLevel,
            task.request.operation.kind === "resources" ? "workers" : task.request.operation.kind,
          ) &&
          !(
            credential.lease.accessLevel === "screen" &&
            task.request.operation.kind === "screen" &&
            joinedScreenRecovery(task.request.operation.request)
          )
        )
          task.abort.abort();
      if (!connected) {
        connected = true;
        options.onConnected?.();
      }
      for (const request of batch.requests) {
        if (active.has(request.id) || active.size >= 16) throw Error("join_request_refused");
        const abort = new AbortController();
        active.set(request.id, { request, abort });
        void executeJoinedMachineRequest(
          request,
          policy,
          credential.localDirectories,
          credential.lease.directories,
          ports,
          AbortSignal.any([signal, abort.signal]),
          () => {
            if (
              signal.aborted ||
              abort.signal.aborted ||
              (request.operation.kind === "resources"
                ? !currentWorkers || performance.now() - resourcePolicyAt >= 2000
                : !freshScreen())
            )
              throw Error("join_policy_unavailable");
          },
          credential.lease.accessLevel === "screen",
        )
          .then((result) => {
            if (results.length < 16) results.push(result);
          })
          .finally(() => active.delete(request.id));
      }
      await pause(options.intervalMs ?? 500);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    channels.delete(localStop);
    if (channels.size === 0) localChannels.delete(credential.lease.token);
    clearInterval(staleTimer);
    currentScreen = false;
    ports.screenPolicy?.(false);
    for (const task of active.values()) task.abort.abort();
    await ports.closeScreen?.();
    await ports.closeResources?.();
  }
  return "left";
}
export async function leaveJoinedMachine(
  credential: JoinedMachineCredential | undefined,
  store: CredentialStore,
  fetcher: typeof fetch = fetch,
): Promise<{ homeNotified: boolean }> {
  if (credential) for (const channel of localChannels.get(credential.lease.token) ?? []) channel.abort();
  if (!store.updateMany) throw Error("join_credential_atomic_update_unavailable");
  await store.updateMany([JOINED_MACHINE_CREDENTIAL, JOINED_MACHINE_REVOCATION], async () => ({
    [JOINED_MACHINE_CREDENTIAL]: undefined,
    [JOINED_MACHINE_REVOCATION]: undefined,
  }));
  if (!credential) return { homeNotified: false };
  try {
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(await exchangeJoinedMachine(credential, { op: "leave", results: [] }, fetcher));
    return { homeNotified: true };
  } catch (error) {
    // A sealed revoked reply also confirms the home no longer permits this machine.
    return { homeNotified: error instanceof JoinedMachineRevoked };
  }
}
