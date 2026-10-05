import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ClankieSettings } from "@clankie/settings";
import { resolveDiscordSettings } from "@clankie/settings";
import {
  DiscordSettingsSchema,
  type DiscordDirectoryRequest,
  type DiscordDirectorySnapshot,
  type DiscordPermissionsRequest,
  type DiscordPermissionsSnapshot,
} from "@clankie/protocol";
import {
  ManagedDiscordPolicyStateSchema,
  type ManagedDiscordPolicyStatus,
} from "@clankie/protocol/managed-discord";
import { discordSettingsRevision } from "./discord-room-routes.ts";
import { ManagedDiscordPolicyConflictError, type HostedBodyClient } from "./hosted-body.ts";

const Saved = ManagedDiscordPolicyStateSchema.extend({
  version: z.literal(1),
  installationId: z.string(),
}).strict();
const LegacySaved = Saved.omit({ sequence: true });

/** The body's current settings own policy. Every retry rereads both the edge fence and current disk. */
export class ManagedDiscord {
  private readonly options: {
    client: Pick<
      HostedBodyClient,
      | "bootstrap"
      | "readDiscordDirectory"
      | "readDiscordPermissions"
      | "readDiscordPolicyState"
      | "syncDiscordPolicy"
    >;
    settings: {
      load(): Promise<ClankieSettings>;
      loadFenced(): Promise<{ settings: ClankieSettings; assertCurrent(): void }>;
    };
    statePath: string;
    environment?: NodeJS.ProcessEnv;
  };
  private applied: z.infer<typeof Saved>;
  private state: ManagedDiscordPolicyStatus["state"] = "pending";
  private running: Promise<void> | undefined;
  constructor(options: ManagedDiscord["options"]) {
    this.options = options;
    this.applied = {
      version: 1,
      installationId: options.client.bootstrap.installationId,
      generation: null,
      revision: null,
      sequence: 0,
    };
    try {
      const raw: unknown = JSON.parse(readFileSync(options.statePath, "utf8"));
      const saved = Saved.safeParse(raw);
      if (saved.success) {
        if (saved.data.installationId === this.applied.installationId) this.applied = saved.data;
      } else if (!LegacySaved.safeParse(raw).success) {
        throw new Error("managed_discord_state_invalid");
      }
      // A revision-only local acknowledgement is discarded. Only a fresh wire fence restores it.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("managed_discord_state_invalid");
    }
  }
  async directory(
    query: DiscordDirectoryRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordDirectorySnapshot> {
    const unavailable = (
      state: "unavailable" | "disconnected" = "unavailable",
    ): DiscordDirectorySnapshot => ({
      schemaVersion: 1,
      body,
      kind: query.kind,
      state,
      entries: [],
      hasMore: false,
      reason: "directory_unavailable",
    });
    if (body !== "bot") return unavailable();
    try {
      const result = await this.options.client.readDiscordDirectory(query);
      if (
        result.snapshot.body !== body ||
        result.snapshot.kind !== query.kind ||
        (query.guildId !== undefined &&
          result.snapshot.entries.some((entry) => entry.guildId !== query.guildId))
      )
        return unavailable();
      return result.snapshot;
    } catch {
      return unavailable();
    }
  }
  async permissions(
    query: DiscordPermissionsRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordPermissionsSnapshot> {
    const unknown: DiscordPermissionsSnapshot = {
      body,
      ...query,
      permissions: {
        view_channel: "not_checked",
        send_messages: "not_checked",
        manage_channels: "not_checked",
        manage_webhooks: "not_checked",
      },
    };
    if (body !== "bot") return unknown;
    try {
      const result = await this.options.client.readDiscordPermissions(query);
      if (
        result.snapshot.body !== body ||
        (query.guildId !== undefined && result.snapshot.guildId !== query.guildId) ||
        result.snapshot.channelId !== query.channelId
      )
        return unknown;
      return result.snapshot;
    } catch {
      return unknown;
    }
  }
  async status(): Promise<ManagedDiscordPolicyStatus> {
    const revision = this.projection((await this.options.settings.load()).discord).revision;
    return {
      state: this.state === "synced" && this.applied.revision !== revision ? "pending" : this.state,
      revision,
      ...(this.applied.revision === null ? {} : { appliedRevision: this.applied.revision }),
    };
  }
  async invitationApplicationId(): Promise<string | undefined> {
    try {
      const binding = await this.options.client.readDiscordPolicyState();
      return binding.generation === null ? undefined : binding.applicationId;
    } catch {
      return undefined;
    }
  }
  sync(): Promise<void> {
    this.running ??= this.reconcile().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async reconcile(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fence = await this.options.client.readDiscordPolicyState();
        if (fence.generation === null) {
          this.state = "disconnected";
          return;
        }
        const source = await this.options.settings.loadFenced();
        const { settings, revision } = this.projection(source.settings.discord);
        if (fence.revision === revision) {
          this.persist({ generation: fence.generation, revision, sequence: fence.sequence });
          this.state = "synced";
          return;
        }
        this.state = "pending";
        source.assertCurrent();
        const accepted = await this.options.client.syncDiscordPolicy({
          generation: fence.generation,
          revision,
          expectedRevision: fence.revision,
          expectedSequence: fence.sequence,
          settings,
        });
        if (
          accepted.generation !== fence.generation ||
          accepted.revision !== revision ||
          accepted.sequence !== fence.sequence + 1
        )
          throw new Error("managed_discord_ack_invalid");
        this.persist(accepted);
        if (this.projection((await this.options.settings.load()).discord).revision === revision) {
          this.state = "synced";
          return;
        }
      } catch (error) {
        this.state = error instanceof ManagedDiscordPolicyConflictError ? "conflict" : "unavailable";
        if (!(error instanceof ManagedDiscordPolicyConflictError)) return;
        // A conflict never reuses the captured policy or blindly adopts its returned revision.
      }
    }
  }
  private projection(settings: ClankieSettings["discord"]) {
    // Role projection may append optional fields. Hash the same schema order that crosses the wire.
    const effective = DiscordSettingsSchema.parse(
      resolveDiscordSettings(settings, this.options.environment ?? {}).settings,
    );
    return { settings: effective, revision: discordSettingsRevision(effective) };
  }
  private persist(fence: { generation: string; revision: string; sequence: number }): void {
    const saved = Saved.parse({
      ...fence,
      version: 1,
      installationId: this.options.client.bootstrap.installationId,
    });
    mkdirSync(dirname(this.options.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.statePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600, flush: true });
    renameSync(temporary, this.options.statePath);
    const directory = openSync(dirname(this.options.statePath), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.applied = saved;
  }
}
