import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  MinecraftHostAdminCommandSchema,
  MinecraftHostUsernameSchema,
  MinecraftHostSettingsSchema,
  MinecraftTunnelClaimStatusSchema,
  MinecraftTunnelErrorSchema,
  type MinecraftHostAdminCommand,
} from "@clankie/protocol";
import type { SettingsStore } from "@clankie/settings";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import { ConversationOwnerSchema, type ConversationOwner } from "./captain/conversation-owner.ts";
import { MINECRAFT_BODY_ACCESS, type McpHost } from "./mcp-host.ts";
import type { MinecraftService } from "./minecraft.ts";

const Username = MinecraftHostUsernameSchema;
const Binding = z.strictObject({
  username: Username,
  owner: ConversationOwnerSchema,
  state: z.enum(["requested", "provisioning", "delivery_pending", "active", "uncertain", "removed"]),
  classification: z.enum(["premium", "nonpremium"]).optional(),
  approved: z.boolean().optional(),
});
const SafeStatus = z.object({
  phase: z.enum(["stopped", "starting", "running", "stopping", "backoff", "failed", "uncertain"]),
  authReady: z.boolean(),
  version: z.literal("1.21.4"),
  supportedClientVersions: z
    .array(z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u))
    .min(1)
    .max(64)
    .optional(),
  gamePort: z.number().int().min(1024).max(65535),
  botUsername: Username,
  lastBackup: z
    .object({ filename: z.string().regex(/^[A-Za-z0-9_.-]+$/u), at: z.number().int().nonnegative() })
    .optional(),
  tunnel: z
    .object({
      phase: z.string().max(64),
      publicAddress: z
        .string()
        .regex(/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/u)
        .optional(),
      error: MinecraftTunnelErrorSchema.catch("playit-start-failed").optional(),
    })
    .optional(),
});
const Enrollment = z.object({
  classification: z.enum(["premium", "nonpremium"]),
  providerId: z
    .string()
    .regex(/^clankie_minecraft_friend_[a-z0-9_]+$/u)
    .optional(),
});

type HostGuard = (
  identity: BodyConversationIdentity | undefined,
  options: { admin: boolean },
) => Promise<() => void>;
type BindingRecord = z.infer<typeof Binding>;

/** Clankie's authority, identities and receipts; Java, RCON and tunnels remain integration-owned. */
export class MinecraftHostService {
  private readonly records = new Map<string, BindingRecord>();
  private corrupt = false;
  private serial: Promise<unknown> = Promise.resolve();
  private effectStarted = false;
  private activeOperationId: string | undefined;
  private readonly options: {
    host: Pick<McpHost, "call">;
    guard: HostGuard;
    settings: Pick<SettingsStore, "load" | "update">;
    minecraft: Pick<MinecraftService, "ownsPlay" | "status" | "leave">;
    bindingPath: string;
    auditPath: string;
    routeAuthorized(owner: ConversationOwner): boolean | Promise<boolean>;
    deliverCode?: (
      input: { operationId: string; owner: ConversationOwner; username: string; providerId: string },
      guard: () => Promise<void>,
    ) => Promise<{ outcome: "delivered" | "refused" | "uncertain" }>;
    invite?: (identity: BodyConversationIdentity, status: unknown) => Promise<unknown>;
  };
  public constructor(options: MinecraftHostService["options"]) {
    this.options = options;
    try {
      const values = z.array(Binding).parse(JSON.parse(readFileSync(options.bindingPath, "utf8")));
      for (const item of values) this.records.set(item.username.toLowerCase(), item);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
        this.corrupt = true;
    }
  }

  public configuration(identity?: BodyConversationIdentity) {
    return this.run("configuration", identity, true, async (id) =>
      MinecraftHostSettingsSchema.parse(await this.rpc("host_configuration", {}, id, true)),
    );
  }
  public configure(input: unknown, identity?: BodyConversationIdentity) {
    const settings = MinecraftHostSettingsSchema.partial().parse(input);
    return this.run("configure", identity, true, async (id) =>
      MinecraftHostSettingsSchema.parse(await this.rpc("host_configure", { settings }, id, true)),
    );
  }
  public status(identity?: BodyConversationIdentity) {
    return this.run("status", identity, false, async (id) =>
      SafeStatus.parse(await this.rpc("host_status", {}, id, false)),
    );
  }
  public lifecycle(operation: "start" | "stop" | "restart", identity?: BodyConversationIdentity) {
    return this.run(operation, identity, operation !== "start", async (id) => {
      const admin = operation === "start" ? await this.authorizeStart(id) : true;
      if (operation !== "stop")
        await this.preflightProfile(SafeStatus.parse(await this.rpc("host_status", {}, id, admin)));
      if (operation !== "start" && this.options.minecraft.ownsPlay()) {
        const status = await this.options.minecraft.status(id);
        if (status.session?.profileId === "clankie-hosted") {
          this.effectStarted = true;
          const left = await this.options.minecraft.leave(id);
          if (left.termination.state !== "confirmed") throw new Error("minecraft_disconnect_uncertain");
        }
      }
      await this.rpc("host_lifecycle", { operation }, id, admin);
      const status = SafeStatus.parse(await this.rpc("host_status", {}, id, admin));
      if (status.authReady) await this.ensureProfile(status, id, admin);
      return status;
    });
  }
  public backup(identity?: BodyConversationIdentity) {
    return this.run("backup", identity, true, async (id) => {
      await this.rpc("host_backup", {}, id, true);
      return { outcome: "completed" };
    });
  }
  public admin(input: MinecraftHostAdminCommand, identity?: BodyConversationIdentity) {
    return this.run("admin", identity, true, async (id) => {
      const command = MinecraftHostAdminCommandSchema.parse(input);
      this.audit({ action: "admin_details", command, conversationId: id.conversationId });
      const key = "username" in command ? command.username.toLowerCase() : undefined;
      if (command.operation === "whitelist_add" && this.records.get(key!)?.state !== "active")
        throw new Error("minecraft_verified_binding_required");
      const reply = await this.rpc("host_admin", { command }, id, true);
      if (command.operation === "list")
        return z.object({ players: z.array(Username).max(1000) }).parse(reply);
      if (command.operation === "whitelist_remove" && key) {
        const record = this.records.get(key);
        if (record) {
          record.state = "removed";
          record.approved = false;
          this.save();
        }
      }
      return { outcome: "completed" };
    });
  }
  public claim(identity?: BodyConversationIdentity) {
    return this.run("claim", identity, true, async (id) =>
      MinecraftTunnelClaimStatusSchema.parse(await this.rpc("host_claim", {}, id, true)),
    );
  }
  public claimStatus(identity?: BodyConversationIdentity) {
    return this.run("claim_status", identity, true, async (id) =>
      MinecraftTunnelClaimStatusSchema.parse(await this.rpc("host_claim_status", {}, id, true)),
    );
  }
  public completeClaim(identity?: BodyConversationIdentity) {
    return this.run("claim_complete", identity, true, async (id) => {
      const result = MinecraftTunnelClaimStatusSchema.parse(
        await this.rpc("host_claim_complete", {}, id, true),
      );
      return {
        ...result,
        outcome: result.claimed
          ? "completed"
          : ["preparing", "pending"].includes(result.phase)
            ? "pending"
            : "refused",
      };
    });
  }
  public requestEnrollment(username: string, identity?: BodyConversationIdentity) {
    return this.run("request_enrollment", identity, false, async (id) => {
      const name = Username.parse(username);
      this.audit({ action: "request_enrollment_details", username: name, conversationId: id.conversationId });
      const owner = id.route?.owner;
      if (!owner?.discord) throw new Error("minecraft_discord_request_required");
      const previous = this.records.get(name.toLowerCase());
      if (previous && previous.owner.discord?.actorId !== owner.discord.actorId)
        throw new Error("minecraft_name_already_bound");
      if (
        previous?.state === "provisioning" ||
        previous?.state === "delivery_pending" ||
        previous?.state === "uncertain"
      )
        throw new Error("minecraft_enrollment_uncertain");
      const renewal = previous?.state === "active";
      this.records.set(name.toLowerCase(), {
        username: name,
        owner: structuredClone(owner),
        state: "requested",
        ...(previous?.approved || previous?.state === "active" ? { approved: true } : {}),
      });
      this.save();
      return { outcome: "requested", username: name, approvalRequired: true, renewal };
    });
  }
  public approveEnrollment(username: string, identity?: BodyConversationIdentity) {
    return this.run("approve_enrollment", identity, true, async (id) => {
      const name = Username.parse(username);
      this.audit({ action: "approve_enrollment_details", username: name, conversationId: id.conversationId });
      const record = this.records.get(name.toLowerCase());
      if (!record || record.state !== "requested") throw new Error("minecraft_verified_request_required");
      const owner = record.owner;
      if (!owner.discord || !(await this.options.routeAuthorized(owner)))
        throw new Error("minecraft_request_route_revoked");
      record.state = "provisioning";
      this.save();
      try {
        const result = Enrollment.parse(
          await this.rpc("host_enroll", { username: record.username }, id, true),
        );
        record.classification = result.classification;
        if (result.classification === "nonpremium") {
          if (!result.providerId || !this.options.deliverCode)
            throw new Error("minecraft_private_delivery_unavailable");
          record.state = "delivery_pending";
          this.save();
          const delivered = await this.options.deliverCode(
            { operationId: randomUUID(), owner, username: record.username, providerId: result.providerId },
            async () => {
              (await this.options.guard(id, { admin: true }))();
              if (!(await this.options.routeAuthorized(owner)))
                throw new Error("minecraft_request_route_revoked");
            },
          );
          if (delivered.outcome !== "delivered") {
            record.state = delivered.outcome === "uncertain" ? "uncertain" : "requested";
            this.save();
            await this.rpc("host_revoke_code", { username: record.username }, id, true).catch(() => {});
            return { outcome: delivered.outcome, reason: "minecraft_private_delivery_failed" };
          }
        }
        await this.rpc(
          "host_admin",
          { command: { operation: "whitelist_add", username: record.username } },
          id,
          true,
        );
        record.state = "active";
        record.approved = true;
        this.save();
        return { outcome: "completed", username: record.username, classification: record.classification };
      } catch {
        record.state = "uncertain";
        this.save();
        throw new Error("minecraft_enrollment_uncertain");
      }
    });
  }
  public invite(identity?: BodyConversationIdentity) {
    return this.run("invite", identity, false, async (id) => {
      if (!this.options.invite) throw new Error("minecraft_invite_unavailable");
      const status = SafeStatus.parse(await this.rpc("host_status", {}, id, false));
      return this.options.invite(id, status);
    });
  }

  private async authorizeStart(identity: BodyConversationIdentity): Promise<boolean> {
    try {
      (await this.options.guard(identity, { admin: true }))();
      return true;
    } catch {
      (await this.options.guard(identity, { admin: false }))();
      const actor = identity.route?.owner.discord?.actorId;
      if (
        !actor ||
        ![...this.records.values()].some(
          (record) =>
            (record.approved || record.state === "active") &&
            record.state !== "removed" &&
            record.owner.discord?.actorId === actor,
        )
      )
        throw new Error("minecraft_host_play_request_not_approved");
      return false;
    }
  }
  private async preflightProfile(status: z.infer<typeof SafeStatus>) {
    const existing = (await this.options.settings.load()).minecraft.profiles.find(
      (item) => item.id === "clankie-hosted",
    );
    if (
      existing &&
      (existing.host !== "127.0.0.1" ||
        existing.port !== status.gamePort ||
        existing.username !== status.botUsername ||
        existing.auth !== "offline" ||
        existing.version !== status.version)
    )
      throw new Error("minecraft_host_profile_collision");
  }
  private async ensureProfile(
    status: z.infer<typeof SafeStatus>,
    identity: BodyConversationIdentity,
    admin: boolean,
  ) {
    const profile = {
      id: "clankie-hosted",
      name: "Clankie's Minecraft server",
      host: "127.0.0.1",
      port: status.gamePort,
      version: status.version,
      username: status.botUsername,
      auth: "offline" as const,
    };
    await this.options.settings.update(
      (settings) => {
        const existing = settings.minecraft.profiles.find((item) => item.id === profile.id);
        if (
          existing &&
          (existing.host !== profile.host ||
            existing.port !== profile.port ||
            existing.username !== profile.username)
        )
          throw new Error("minecraft_host_profile_collision");
        return {
          ...settings,
          minecraft: {
            ...settings.minecraft,
            profiles: [...settings.minecraft.profiles.filter((item) => item.id !== profile.id), profile],
          },
        };
      },
      async () => {
        if (admin) (await this.options.guard(identity, { admin: true }))();
        else await this.authorizeStart(identity);
      },
    );
  }
  private async rpc(
    tool: string,
    args: Record<string, unknown>,
    identity: BodyConversationIdentity,
    admin: boolean,
  ) {
    const reply = await this.options.host.call({
      server: "minecraft",
      lane: "operator",
      tool,
      arguments: args,
      bodyAccess: MINECRAFT_BODY_ACCESS,
      resultMode: "data",
      timeoutMs: tool === "host_lifecycle" ? 1_200_000 : 60_000,
      fence: async () => {
        const current = await this.options.guard(identity, { admin });
        return () => {
          current();
          if (
            tool !== "host_status" &&
            tool !== "host_configuration" &&
            tool !== "host_claim_status" &&
            !(tool === "host_admin" && (args.command as { operation?: string })?.operation === "list")
          )
            this.effectStarted = true;
        };
      },
    });
    if (reply.outcome !== "ok" || reply.isError) throw new Error("minecraft_host_dispatch_uncertain");
    try {
      return JSON.parse(reply.content) as unknown;
    } catch {
      throw new Error("minecraft_host_reply_invalid");
    }
  }
  private run(
    action: string,
    identity: BodyConversationIdentity | undefined,
    admin: boolean,
    operation: (identity: BodyConversationIdentity) => Promise<unknown>,
  ): Promise<unknown> {
    const queued = this.serial.then(async () => {
      const operationId = randomUUID();
      const principal = identity?.route?.owner.discord?.actorId ?? "operator";
      this.audit({
        operationId,
        action,
        principal,
        conversationId: identity?.conversationId,
        outcome: "attempted",
      });
      this.effectStarted = false;
      this.activeOperationId = operationId;
      try {
        if (this.corrupt) throw new Error("minecraft_bindings_unavailable");
        (await this.options.guard(identity, { admin }))();
        const result = await operation(identity!);
        const outcome =
          result &&
          typeof result === "object" &&
          "outcome" in result &&
          ["refused", "uncertain"].includes(String(result.outcome))
            ? result.outcome
            : "completed";
        this.audit({ operationId, action, principal, outcome });
        return result;
      } catch (error) {
        const outcome = this.effectStarted ? "uncertain" : "refused";
        const candidate = error instanceof Error ? error.message : undefined;
        const reason =
          candidate && /^minecraft_[a-z_]+$/u.test(candidate) ? candidate : "minecraft_host_request_failed";
        this.audit({ operationId, action, principal, outcome, reason });
        return { outcome, reason };
      }
    });
    this.serial = queued.catch(() => {});
    return queued;
  }
  private audit(record: Record<string, unknown>) {
    mkdirSync(dirname(this.options.auditPath), { recursive: true, mode: 0o700 });
    const descriptor = openSync(this.options.auditPath, "a", 0o600);
    try {
      appendFileSync(
        descriptor,
        `${JSON.stringify({ at: Date.now(), operationId: this.activeOperationId, ...record })}\n`,
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
  private save() {
    this.effectStarted = true;
    mkdirSync(dirname(this.options.bindingPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.bindingPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.records.values()]), { mode: 0o600 });
    renameSync(temporary, this.options.bindingPath);
  }
}
