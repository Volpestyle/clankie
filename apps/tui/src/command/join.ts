import { randomBytes } from "node:crypto";
import { openGatewayValue } from "../../../clankie/src/gateway-encryption.ts";
import { machineJoinHash, machineJoinKey } from "../../../clankie/src/machine-join-crypto.ts";
import { hostname } from "node:os";
import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  createDefaultCredentialStore,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { PublicGatewayHostIdSchema } from "@clankie/protocol/public-gateway";
import {
  MACHINE_JOIN_START_PATH,
  MACHINE_JOIN_STATUS_PATH,
  MACHINE_JOIN_APPROVE_PATH,
  MachineJoinStartSchema,
  MachineJoinLeaseSchema,
  machineJoinLeaseAad,
  MachineJoinTicketSchema,
  MachineJoinStatusSchema,
  MachineJoinApprovalSchema,
  MachineJoinApprovalResultSchema,
} from "@clankie/protocol/machine-join";
import {
  machineJoinOrigin,
  readJoinedMachineCredential,
  saveJoinedMachineCredential,
  runJoinedMachineChannel,
  leaveJoinedMachine,
  type JoinedMachinePorts,
} from "../../bin/joined-machine-client.ts";
import { commandHost, type Writable } from "./io.ts";

const USAGE =
  "Usage: clankie join --gateway URL --host HOST_ID [--name NAME] [--directory PATH]…\n       clankie join resume|status|leave\n       clankie join approve CODE --access portal|workers|shell|screen [--directory PATH]…";
export async function runJoinCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly operatorCredentialStore?: CredentialStore;
    readonly joinCredentialStore?: CredentialStore;
    readonly signal?: AbortSignal;
    readonly stdout?: Writable;
    readonly stderr?: Writable;
    readonly ports?: JoinedMachinePorts;
    readonly intervalMs?: number;
  } = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout,
    stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const fetcher = options.fetchImpl ?? fetch;
  const abort = new AbortController();
  const signal = options.signal ?? abort.signal;
  const interrupt = () => abort.abort();
  if (!options.signal) {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
  }
  try {
    // A base64url approval secret may start with '-'; it is always positional data.
    const approvalCode =
      args[0] === "approve" && MachineJoinApprovalSchema.shape.code.safeParse(args[1]).success
        ? args[1]
        : undefined;
    const { positionals, values } = parseArgs({
      args: approvalCode ? ["approve", "CODE", ...args.slice(2)] : [...args],
      allowPositionals: true,
      options: {
        gateway: { type: "string" },
        host: { type: "string" },
        name: { type: "string" },
        directory: { type: "string", multiple: true },
        access: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      stdout.write(USAGE + "\n");
      return 0;
    }
    const [action = "start", parsedTarget] = positionals;
    const target = approvalCode ?? parsedTarget;
    const post = async (origin: string, path: string, body: unknown, token?: string) => {
      const response = await fetcher(origin + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw Error("join_unavailable");
      return response.json();
    };
    if (action === "approve") {
      if (positionals.length !== 2 || values.gateway || values.host || values.name) throw Error(USAGE);
      const input = MachineJoinApprovalSchema.parse({
        code: target,
        accessLevel: values.access,
        directories: values.directory ?? [],
      });
      const owner = await resolveOperatorCredential({
        env,
        ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
      });
      if (!owner) throw Error("authentication_required");
      const result = MachineJoinApprovalResultSchema.parse(
        await post(commandHost({ ...options, env }), MACHINE_JOIN_APPROVE_PATH, input, owner.token),
      );
      stdout.write(
        JSON.stringify({ ok: true, machineId: result.machineId, accessLevel: input.accessLevel }) + "\n",
      );
      return 0;
    }
    if (positionals.length > 1 || values.access || !["start", "resume", "status", "leave"].includes(action))
      throw Error(USAGE);
    if (action !== "start" && Object.keys(values).length > 0) throw Error(USAGE);
    const store = options.joinCredentialStore ?? createDefaultCredentialStore({ env });
    let credential = await readJoinedMachineCredential(store);
    if (action === "status") {
      stdout.write(
        JSON.stringify(
          credential
            ? { configured: true, machineId: credential.lease.machineId, origin: credential.origin }
            : { configured: false },
        ) + "\n",
      );
      return 0;
    }
    if (action === "leave") {
      if (credential) await leaveJoinedMachine(credential, store, fetcher);
      stdout.write('{"ok":true,"left":true}\n');
      return 0;
    }
    if (action === "start") {
      if (credential) throw Error("already_joined_use_resume_or_leave");
      if (!values.gateway || !values.host) throw Error(USAGE);
      const gateway = new URL(machineJoinOrigin(values.gateway));
      if (gateway.pathname !== "/") throw Error("join_origin_refused");
      const host = PublicGatewayHostIdSchema.parse(values.host);
      const origin = `${gateway.origin}/h/${host}`;
      const directories = await Promise.all((values.directory ?? []).map((path) => realpath(path)));
      const claimSecret = randomBytes(32).toString("base64url");
      const approvalCode = randomBytes(32).toString("base64url");
      const input = MachineJoinStartSchema.parse({
        name: values.name ?? hostname(),
        platform: process.platform,
        directories,
        claimSecret,
        approvalHash: machineJoinHash(approvalCode),
      });
      const ticket = MachineJoinTicketSchema.parse(await post(origin, MACHINE_JOIN_START_PATH, input));
      stdout.write(`Approve ${approvalCode} from an existing owner device (expires ${ticket.expiresAt}).\n`);
      while (!signal.aborted && Date.now() < Date.parse(ticket.expiresAt)) {
        const status = MachineJoinStatusSchema.parse(
          await post(origin, MACHINE_JOIN_STATUS_PATH, { joinId: ticket.joinId }, claimSecret),
        );
        if (status.state === "approved") {
          const lease = MachineJoinLeaseSchema.parse(
            JSON.parse(
              openGatewayValue(
                machineJoinKey(approvalCode),
                status.sealedLease,
                machineJoinLeaseAad(ticket.joinId),
              ),
            ),
          );
          credential = { origin, lease, localDirectories: directories };
          await saveJoinedMachineCredential(store, credential);
          break;
        }
        if (status.state !== "pending") throw Error("join_approval_expired");
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, options.intervalMs ?? 1000);
          signal.addEventListener("abort", done, { once: true });
        });
      }
    }
    if (!credential) {
      if (signal.aborted) return 0;
      throw Error("join_approval_required");
    }
    const state = await runJoinedMachineChannel(credential, {
      store,
      signal,
      fetchImpl: fetcher,
      ...(options.ports ? { ports: options.ports } : {}),
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      onConnected: () => stdout.write(`Joined ${credential!.lease.machineId}; keep this command running.\n`),
    });
    stdout.write(JSON.stringify({ ok: true, state }) + "\n");
    return 0;
  } catch {
    if (signal.aborted) return 0;
    // Parser/provider responses may contain capabilities: never print raw exceptions.
    stderr.write(
      "Join could not complete. Check approval, gateway availability and the join status; an uncertain join is never retried.\n",
    );
    return 1;
  } finally {
    if (!options.signal) {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}
