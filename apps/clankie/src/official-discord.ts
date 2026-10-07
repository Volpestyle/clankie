import { createECDH } from "node:crypto";
import type { CredentialStore } from "@clankie/credential-broker";
import { hostedOrigin } from "@clankie/protocol/hosted-pairing";
import {
  OFFICIAL_DISCORD_PATHS,
  OfficialDiscordRegistrationSchema,
  type OfficialDiscordRegistration,
} from "@clankie/protocol/official-discord";
import type { CaptainPort } from "./captain/port.ts";
import { DiscordIngress, discordIngressExecutor, type DiscordIngressPort } from "./discord-ingress.ts";
import { hostedVerifyKeys } from "./hosted-body.ts";

/** Broker id of this installation's official-bot ingress key. Never leaves the machine. */
export function officialDiscordKeyProvider(installationId: string): string {
  return `clankie-discord-ingress-official-${installationId}`;
}

/**
 * The free official Clankie bot on a self-hosted machine (VUH-1766).
 *
 * The machine registers an ingress sealing key with the hosted fleet using its
 * signed-in Clankie account. The hosted edge, which alone holds the official
 * bot token, then sends sealed, fleet-permitted events through the public
 * gateway connection this machine already keeps. Authority stays local: the
 * edge's owner flag grants nothing here, so Discord users get exactly what this
 * machine's own Discord settings (`ownerUserId`, `systemActorUserIds`, trusted
 * rooms) grant them, the same as a bring-your-own bot.
 */
export class OfficialDiscordIngress implements DiscordIngressPort {
  private inner: DiscordIngress | undefined;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: {
    gatewayUrl: string;
    installationId: string;
    store: CredentialStore;
    statePath: string;
    captain: CaptainPort;
    resolveAccountToken: () => Promise<{ token: string }>;
    fetchImpl?: typeof fetch;
    onWork?: () => void;
    onCode?: (code: string) => void;
    retryMs?: number;
  };
  constructor(options: OfficialDiscordIngress["options"]) {
    this.options = options;
  }
  /** Registered and accepting deliveries. */
  get ready(): boolean {
    return this.inner !== undefined;
  }
  accept(input: unknown): Response {
    // Until the fleet confirms the key, nothing could have been sealed to it.
    if (!this.inner) return Response.json({ error: "unavailable" }, { status: 503 });
    return this.inner.accept(input);
  }
  /** Registers, retrying in the background; startup never waits on the network. */
  start(): void {
    void this.register();
  }
  close(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  async register(): Promise<OfficialDiscordRegistration | undefined> {
    try {
      const key = createECDH("prime256v1");
      const provider = officialDiscordKeyProvider(this.options.installationId);
      const existing = await this.options.store.get(provider);
      if (existing) {
        if (existing.type !== "api") throw new Error("discord_key_invalid");
        key.setPrivateKey(Buffer.from(existing.key, "hex"));
      } else {
        key.generateKeys();
        await this.options.store.set(provider, {
          type: "api",
          key: key.getPrivateKey().toString("hex"),
        });
      }
      const { token } = await this.options.resolveAccountToken();
      const response = await (this.options.fetchImpl ?? fetch)(
        new URL(OFFICIAL_DISCORD_PATHS.register, hostedOrigin(this.options.gatewayUrl)),
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            installationId: this.options.installationId,
            publicKey: key.getPublicKey().toString("base64url"),
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        const code = await response
          .json()
          .then((body: unknown) => (body as { error?: unknown }).error)
          .catch(() => undefined);
        throw new Error(typeof code === "string" ? code : `http_${String(response.status)}`);
      }
      const registration = OfficialDiscordRegistrationSchema.parse(await response.json());
      if (registration.installationId !== this.options.installationId)
        throw new Error("installation_mismatch");
      if (this.stopped) return undefined;
      this.inner = new DiscordIngress({
        tenantId: registration.routeId,
        installationId: registration.installationId,
        key,
        verifyKeys: hostedVerifyKeys(JSON.stringify(registration.verifyKeys)),
        statePath: this.options.statePath,
        ...(this.options.onWork === undefined ? {} : { onWork: this.options.onWork }),
        execute: discordIngressExecutor({
          captain: this.options.captain,
          // Self-hosted authority comes from this machine's settings, never the edge.
          verifiedOwner: () => false,
          current: () => !this.stopped,
        }),
      });
      this.options.onCode?.("official_discord_registered");
      return registration;
    } catch (error) {
      this.options.onCode?.(
        `official_discord_register_failed:${error instanceof Error ? error.message.slice(0, 64) : "unknown"}`,
      );
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.register(), this.options.retryMs ?? 60_000);
        this.timer.unref();
      }
      return undefined;
    }
  }
}
