/** Outbound-only public join host. Gateway deployment/routing is an ops responsibility. */
import { randomBytes, randomUUID } from "node:crypto";
import { openGatewayValue, sealGatewayValue } from "../../clankie/src/gateway-encryption.ts";
import { machineJoinKey } from "../../clankie/src/machine-join-crypto.ts";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";
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
  machineJoinExchangeAad,
  MACHINE_JOIN_LEAVE_PATH,
  JoinedMachineBatchSchema,
  MachineJoinLeaseSchema,
  JoinedMachineRequestSchema,
  type JoinedMachinePolicy,
  type JoinedMachineRequest,
  type JoinedMachineResult,
} from "@clankie/protocol/machine-join";

const JOINED_MACHINE_CREDENTIAL = "clankie-joined-machine";
const JoinedMachineCredentialSchema = z
  .object({
    origin: z.string().url(),
    lease: MachineJoinLeaseSchema,
    localDirectories: z.array(z.string().min(1).max(4096)).max(32),
  })
  .strict();
export type JoinedMachineCredential = z.infer<typeof JoinedMachineCredentialSchema>;
const exec = promisify(execFile);

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
): Promise<JoinedMachineCredential | undefined> {
  const value = await store.get(JOINED_MACHINE_CREDENTIAL);
  if (!value) return undefined;
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
  await store.set(JOINED_MACHINE_CREDENTIAL, { type: "api", key: JSON.stringify(credential) });
}
export interface JoinedMachinePorts {
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
  screenGuard: () => void,
  originallyScreen: boolean,
): Promise<JoinedMachineResult> {
  const request = JoinedMachineRequestSchema.parse(raw);
  const operation = request.operation;
  if (signal.aborted) return { id: request.id, ok: false, error: "revoked" };
  if (
    !machineAccessAllows(policy.accessLevel, operation.kind) &&
    !(originallyScreen && operation.kind === "screen" && joinedScreenRecovery(operation.request))
  )
    return { id: request.id, ok: false, error: "machine_access_refused" };
  let directory = "";
  if (operation.kind !== "screen") {
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
    const handler = ports[operation.kind];
    if (!handler) return { id: request.id, ok: false, error: "operation_unavailable" };
    const output =
      operation.kind === "screen"
        ? await ports.screen!(operation.request, signal, screenGuard)
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
export const joinedMachineShell: NonNullable<JoinedMachinePorts["shell"]> = async (
  command,
  directory,
  signal,
) => {
  const windows = process.platform === "win32";
  const result = await exec(
    windows ? "powershell.exe" : "/bin/sh",
    windows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command],
    {
      cwd: directory,
      signal,
      timeout: 30_000,
      maxBuffer: 65_536,
    },
  );
  return result.stdout;
};

class JoinedMachineRevoked extends Error {}
/** A fresh one-use challenge binds each encrypted request and independently keyed response. */
export async function exchangeJoinedMachine(
  credential: JoinedMachineCredential,
  input: { op: "poll" | "leave"; results: JoinedMachineResult[] },
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
    if (response.status === 403 && value.error === "revoked") throw new JoinedMachineRevoked("revoked");
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
      await post(input.op === "poll" ? MACHINE_JOIN_CHANNEL_PATH : MACHINE_JOIN_LEAVE_PATH, {
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
  return JSON.parse(
    openGatewayValue(machineJoinKey(responseSecret), response.sealedResponse, aad("response")),
  );
}

/** Claims are one-shot: a lost response parks the client instead of replaying any operation. */
export async function runJoinedMachineChannel(
  credential: JoinedMachineCredential,
  options: {
    store: CredentialStore;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    ports?: JoinedMachinePorts;
    intervalMs?: number;
    onConnected?: () => void;
  },
): Promise<"left" | "revoked"> {
  machineJoinOrigin(credential.origin);
  const active = new Map<string, { request: JoinedMachineRequest; abort: AbortController }>();
  let results: JoinedMachineResult[] = [];
  const fetcher = options.fetchImpl ?? fetch;
  let connected = false;
  let currentScreen = false;
  let policyAt = 0;
  const ports = options.ports ?? { shell: joinedMachineShell };
  const freshScreen = () => currentScreen && performance.now() - policyAt < 2000;
  const staleTimer = setInterval(() => ports.screenPolicy?.(freshScreen()), 250);
  try {
    while (!options.signal.aborted) {
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
            AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
          ),
        );
      } catch (error) {
        if (!(error instanceof JoinedMachineRevoked)) throw error;
        await options.store.delete(JOINED_MACHINE_CREDENTIAL);
        return "revoked";
      }
      if (batch.policy.machineId !== credential.lease.machineId) throw Error("join_identity_refused");
      const policy = {
        ...batch.policy,
        accessLevel: machineAccessAllows(credential.lease.accessLevel, batch.policy.accessLevel)
          ? batch.policy.accessLevel
          : credential.lease.accessLevel,
      };
      policyAt = performance.now();
      currentScreen = policy.accessLevel === "screen";
      ports.screenPolicy?.(freshScreen());
      for (const task of active.values())
        if (
          !machineAccessAllows(policy.accessLevel, task.request.operation.kind) &&
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
          AbortSignal.any([options.signal, abort.signal]),
          () => {
            if (options.signal.aborted || abort.signal.aborted || !freshScreen())
              throw Error("screen_policy_unavailable");
          },
          credential.lease.accessLevel === "screen",
        )
          .then((result) => {
            if (results.length < 16) results.push(result);
          })
          .finally(() => active.delete(request.id));
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          options.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, options.intervalMs ?? 500);
        options.signal.addEventListener("abort", done, { once: true });
      });
    }
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    clearInterval(staleTimer);
    currentScreen = false;
    ports.screenPolicy?.(false);
    for (const task of active.values()) task.abort.abort();
    await ports.closeScreen?.();
  }
  return "left";
}
export async function leaveJoinedMachine(
  credential: JoinedMachineCredential,
  store: CredentialStore,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  try {
    z.object({ ok: z.literal(true) })
      .strict()
      .parse(await exchangeJoinedMachine(credential, { op: "leave", results: [] }, fetcher));
  } catch (error) {
    if (!(error instanceof JoinedMachineRevoked)) throw error;
  }
  await store.delete(JOINED_MACHINE_CREDENTIAL);
}
