import { openGatewayValue, sealGatewayValue } from "./gateway-encryption.ts";
import { machineJoinHash as hash, machineJoinKey } from "./machine-join-crypto.ts";
/** Service-owned join approval and revocation. No hosted gateway or account control plane. */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CredentialStore } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { MachineAccessLevelSchema, type Machine, type MachineAccessLevel } from "@clankie/protocol";
import {
  MachineJoinEnvelopeSchema,
  MachineJoinPayloadSchema,
  JoinedMachineIdSchema as JoinedId,
  machineJoinLeaseAad,
  machineJoinExchangeAad,
  MachineJoinStartSchema,
  MachineJoinApprovalSchema,
  JoinedMachineIdSchema,
  JoinedMachineOperationSchema,
  JoinedMachinePollSchema,
  type MachineJoinStart,
  type MachineJoinLease,
  type JoinedMachineOperation,
  type JoinedMachineRequest,
  type JoinedMachineResult,
} from "@clankie/protocol/machine-join";
import { machineAccessLevel } from "./machine-access.ts";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../../tui/bin/update-files.ts";

const credentialName = (id: string) => `clankie-joined-host-${id}`;
const RegistrationSchema = z
  .object({
    id: JoinedMachineIdSchema,
    name: z.string().min(1).max(100),
    platform: MachineJoinStartSchema.shape.platform,
    directories: MachineJoinStartSchema.shape.directories,
    accessCeiling: MachineAccessLevelSchema,
    tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
type Registration = z.infer<typeof RegistrationSchema>;
interface Ticket {
  readonly id: string;
  readonly input: MachineJoinStart;
  readonly expiresAt: number;
  lease?: { machineId: string; sealed: string };
  approving?: boolean;
}
interface Work {
  readonly request: JoinedMachineRequest;
  readonly machineId: string;
  claimed: boolean;
  settle(result: JoinedMachineResult): void;
}
export class MachineJoins {
  private readonly registrations = new Map<string, Registration>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly seen = new Map<string, number>();
  private readonly work = new Map<string, Work>();
  private readonly challenges = new Map<string, { machineId: string; expiresAt: number }>();
  private readonly file: string;
  private readonly options: {
    settings: SettingsStore;
    secrets: CredentialStore;
    directory: string;
    changed?: () => void;
    now?: () => number;
  };
  constructor(options: MachineJoins["options"]) {
    this.options = options;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    privateDirectory(options.directory);
    this.file = join(options.directory, "machines.json");
    if (existsSync(this.file)) {
      const rows = z.array(RegistrationSchema).max(64).parse(readPrivateJson(this.file));
      for (const row of rows) {
        if (this.registrations.has(row.id)) throw Error("Duplicate joined machine");
        this.registrations.set(row.id, row);
      }
    }
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private save() {
    writePrivateJson(this.file, [...this.registrations.values()]);
    this.options.changed?.();
  }
  get count(): number {
    return this.registrations.size;
  }
  has(id: string) {
    return this.registrations.has(id);
  }
  accessCeiling(id: string): MachineAccessLevel | undefined {
    return this.registrations.get(id)?.accessCeiling;
  }
  start(raw: unknown) {
    const input = MachineJoinStartSchema.parse(raw);
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= this.now()) this.tickets.delete(id);
    if (this.tickets.size >= 32 || this.registrations.size >= 64) throw Error("join_capacity");
    const id = randomUUID();
    const expiresAt = this.now() + 5 * 60_000;
    this.tickets.set(id, { id, input, expiresAt });
    return { joinId: id, expiresAt: new Date(expiresAt).toISOString() };
  }
  status(id: string, claim: string) {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.expiresAt <= this.now() || hash(claim) !== hash(ticket.input.claimSecret))
      return { state: "expired" as const };
    if (!ticket.lease) return { state: "pending" as const };
    return this.has(ticket.lease.machineId)
      ? { state: "approved" as const, sealedLease: ticket.lease.sealed }
      : { state: "revoked" as const };
  }
  async approve(raw: unknown, guard: () => Promise<void>) {
    const input = MachineJoinApprovalSchema.parse(raw);
    const ticket = [...this.tickets.values()].find(
      (entry) => entry.input.approvalHash === hash(input.code) && entry.expiresAt > this.now(),
    );
    if (!ticket || ticket.lease || ticket.approving) throw Error("join_not_pending");
    if (input.directories.some((dir) => !ticket.input.directories.includes(dir)))
      throw Error("directory_refused");
    ticket.approving = true;
    const machineId = `join-${randomUUID()}`;
    let stored = false;
    try {
      const token = `clankie_join_${randomBytes(32).toString("base64url")}`;
      await guard();
      await this.options.secrets.set(credentialName(machineId), { type: "api", key: token });
      stored = true;
      await this.options.settings.update((current) => {
        const approving = [...this.tickets.values()].filter(
          (entry) => entry.approving && !entry.lease,
        ).length;
        if (current.machines.length + this.registrations.size + approving > 63) throw Error("join_capacity");
        return { ...current, machineAccess: { ...current.machineAccess, [machineId]: input.accessLevel } };
      }, guard);
      await guard();
      if (ticket.expiresAt <= this.now()) throw Error("join_expired");
      this.registrations.set(machineId, {
        id: machineId,
        name: ticket.input.name,
        platform: ticket.input.platform,
        directories: input.directories,
        accessCeiling: input.accessLevel,
        tokenHash: hash(token),
      });
      try {
        this.save();
      } catch (error) {
        this.registrations.delete(machineId);
        throw error;
      }
      const lease: MachineJoinLease = {
        machineId,
        token,
        accessLevel: input.accessLevel,
        directories: input.directories,
      };
      ticket.lease = {
        machineId,
        sealed: sealGatewayValue(
          machineJoinKey(input.code),
          JSON.stringify(lease),
          machineJoinLeaseAad(ticket.id),
        ),
      };
      return { ok: true, machineId, accessLevel: input.accessLevel };
    } catch (error) {
      if (stored && !this.has(machineId)) await this.options.secrets.delete(credentialName(machineId));
      throw error;
    } finally {
      ticket.approving = false;
    }
  }
  challenge(raw: unknown) {
    const id = JoinedId.parse(raw);
    if (!this.has(id)) throw Error("revoked");
    for (const [key, value] of this.challenges)
      if (value.expiresAt <= this.now()) this.challenges.delete(key);
    if (this.challenges.size >= 512) throw Error("join_capacity");
    const challenge = randomBytes(32).toString("base64url");
    this.challenges.set(challenge, { machineId: id, expiresAt: this.now() + 60_000 });
    return { challenge };
  }
  async exchange(raw: unknown, op: "poll" | "leave") {
    const envelope = MachineJoinEnvelopeSchema.parse(raw);
    const record = this.registrations.get(envelope.machineId);
    if (!record) throw Error("revoked");
    const secret = await this.options.secrets.get(credentialName(record.id));
    if (!secret || secret.type !== "api" || hash(secret.key) !== record.tokenHash)
      throw Error("join_secret_unavailable");
    if (!this.has(record.id)) throw Error("revoked");
    const payload = MachineJoinPayloadSchema.parse(
      JSON.parse(
        openGatewayValue(
          machineJoinKey(secret.key),
          envelope.sealedRequest,
          machineJoinExchangeAad("request", record.id, envelope.requestId, envelope.challenge),
        ),
      ),
    );
    const challenge = this.challenges.get(envelope.challenge);
    if (
      payload.op !== op ||
      !challenge ||
      challenge.machineId !== record.id ||
      challenge.expiresAt <= this.now()
    )
      throw Error("invalid_machine_request");
    this.challenges.delete(envelope.challenge); // Consume before any dispatch; a replay cannot execute again.
    const result =
      op === "poll"
        ? await this.poll(secret.key, { results: payload.results })
        : await this.leave(secret.key);
    return {
      sealedResponse: sealGatewayValue(
        machineJoinKey(payload.responseSecret),
        JSON.stringify(result),
        machineJoinExchangeAad("response", record.id, envelope.requestId, envelope.challenge),
      ),
    };
  }
  private authenticate(token: string): Registration {
    const record = [...this.registrations.values()].find((entry) => entry.tokenHash === hash(token));
    if (!record) throw Error("revoked");
    return record;
  }
  async poll(token: string, raw: unknown) {
    const record = this.authenticate(token);
    const input = JoinedMachinePollSchema.parse(raw);
    for (const result of input.results) {
      const work = this.work.get(result.id);
      if (work?.machineId === record.id && work.claimed) {
        if (result.screenOutput !== undefined && work.request.operation.kind !== "screen")
          throw Error("join_result_refused");
        work.settle(result);
      }
    }
    const settings = await this.options.settings.load();
    if (!this.has(record.id)) throw Error("revoked");
    const accessLevel = machineAccessLevel(settings, record.id, this);
    const previous = this.seen.get(record.id);
    const now = this.now();
    this.seen.set(record.id, now);
    // Heartbeats do not force repeated SSH discovery; invalidate only on arrival/recovery.
    if (previous === undefined || now - previous >= 15_000) this.options.changed?.();
    const requests = [...this.work.values()]
      .filter((work) => work.machineId === record.id && !work.claimed)
      .slice(0, 16);
    for (const work of requests) work.claimed = true; // Lost delivery is never replayed.
    return {
      policy: { machineId: record.id, accessLevel, directories: record.directories },
      requests: requests.map((work) => work.request),
    };
  }
  async leave(token: string) {
    const record = this.authenticate(token);
    await this.remove(record.id);
    await this.options.settings.update((current) => ({
      ...current,
      machineAccess: Object.fromEntries(
        Object.entries(current.machineAccess).filter(([id]) => id !== record.id),
      ),
    }));
    return { ok: true };
  }
  async remove(id: string) {
    if (!this.has(id)) throw Error("unknown_joined_machine");
    const record = this.registrations.get(id)!;
    this.registrations.delete(id);
    try {
      this.save();
    } catch (error) {
      this.registrations.set(id, record);
      throw error;
    }
    this.seen.delete(id);
    for (const [challenge, value] of this.challenges)
      if (value.machineId === id) this.challenges.delete(challenge);
    for (const work of this.work.values())
      if (work.machineId === id) work.settle({ id: work.request.id, ok: false, error: "revoked" });
    await this.options.secrets.delete(credentialName(id));
  }
  async inventory(): Promise<Machine[]> {
    const settings = await this.options.settings.load();
    return [...this.registrations.values()].map((record) => ({
      id: record.id,
      name: record.name,
      platform: record.platform,
      transport: "join" as const,
      configured: true,
      state:
        this.seen.has(record.id) && this.now() - this.seen.get(record.id)! < 15_000
          ? ("available" as const)
          : ("unreachable" as const),
      workerCount: null,
      sessions: [],
      accessLevel: machineAccessLevel(settings, record.id, this),
      accessEnforcement: "joined-host" as const,
    }));
  }
  request(id: string, raw: JoinedMachineOperation, timeoutMs = 45_000): Promise<JoinedMachineResult> {
    const operation = JoinedMachineOperationSchema.parse(raw);
    if (!this.has(id)) return Promise.reject(Error("unknown_joined_machine"));
    if (this.work.size >= 128) return Promise.reject(Error("join_capacity"));
    const request = { id: randomUUID(), operation };
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => settle({ id: request.id, ok: false, error: "operation_failed" }),
        timeoutMs,
      );
      const settle = (result: JoinedMachineResult) => {
        clearTimeout(timer);
        this.work.delete(request.id);
        resolve(result);
      };
      this.work.set(request.id, { request, machineId: id, claimed: false, settle });
    });
  }
}
