import { createECDH } from "node:crypto";
import type { CredentialStore } from "@clankie/credential-broker";
import { hostedOrigin } from "@clankie/protocol/hosted-pairing";
import {
  OFFICIAL_DISCORD_ACCOUNT_PAGE,
  OFFICIAL_DISCORD_PATHS,
  OfficialDiscordRegistrationSchema,
  OfficialDiscordStatusSchema,
  type OfficialDiscordBodyRefusal,
  type OfficialDiscordBodyStatus,
  type OfficialDiscordRegistration,
  type OfficialDiscordStatus,
} from "@clankie/protocol/official-discord";
import type { ClankieSettings } from "@clankie/settings";
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

/** The signed-in account route this machine already keeps for its gateway. */
export interface OfficialDiscordAccountRoute {
  gatewayUrl: string;
  installationId: string;
  resolveAccountToken: () => Promise<{ token: string }>;
}

/**
 * Turns the official bot on and off in the running service and reports its
 * live status from the fleet (VUH-1766), so neither the app nor the CLI needs a
 * restart. It is also the service's Discord ingress: deliveries reach the
 * current registration, and nothing is accepted while the bot is off.
 */
export class OfficialDiscordControl implements DiscordIngressPort {
  private ingress: OfficialDiscordIngress | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly options: {
    settings: {
      load(): Promise<ClankieSettings>;
      update(
        mutate: (current: ClankieSettings) => ClankieSettings,
        guard?: () => Promise<void>,
      ): Promise<ClankieSettings>;
    };
    /** Absent while this machine is not signed in to a Clankie account. */
    account?: OfficialDiscordAccountRoute;
    open(account: OfficialDiscordAccountRoute): OfficialDiscordIngress;
    fetchImpl?: typeof fetch;
  };
  constructor(options: OfficialDiscordControl["options"]) {
    this.options = options;
  }
  accept(input: unknown): Response {
    if (!this.ingress) return Response.json({ error: "not_found" }, { status: 404 });
    return this.ingress.accept(input);
  }
  /** Starts the saved setting at boot; registration retries in the background. */
  async start(): Promise<void> {
    const enabled = (await this.options.settings.load()).discord.officialBotEnabled;
    if (enabled && this.options.account && !this.ingress) {
      this.ingress = this.options.open(this.options.account);
      this.ingress.start();
    }
  }
  close(): void {
    this.ingress?.close();
    this.ingress = undefined;
  }
  async status(): Promise<OfficialDiscordBodyStatus> {
    const enabled = (await this.options.settings.load()).discord.officialBotEnabled;
    const account = this.options.account;
    const base = {
      schemaVersion: 1 as const,
      enabled,
      running: this.ingress?.ready === true,
      signedIn: account !== undefined,
      ...(account === undefined
        ? {}
        : {
            installUrl: new URL(OFFICIAL_DISCORD_ACCOUNT_PAGE, hostedOrigin(account.gatewayUrl)).toString(),
          }),
    };
    if (account === undefined)
      return {
        ...base,
        fleetError: "not_signed_in",
        next: "Sign in with clankie remote-access on to use the free official Clankie bot.",
      };
    let official: OfficialDiscordStatus;
    try {
      official = OfficialDiscordStatusSchema.parse(
        await this.fleet(account, OFFICIAL_DISCORD_PATHS.status, "GET"),
      );
    } catch (error) {
      return { ...base, fleetError: errorCode(error) };
    }
    const next = official.blocked
      ? `The official bot is blocked for this ${official.blocked.scope}: ${official.blocked.reason}`
      : !enabled
        ? "Turn on the official bot."
        : !base.running
          ? "This machine is still registering with your account."
          : !official.discord.connected
            ? "Open installUrl and choose Add to Discord."
            : undefined;
    return {
      ...base,
      installUrl: official.installUrl,
      official,
      ...(next === undefined ? {} : { next: next.slice(0, 500) }),
    };
  }
  /**
   * Saves the setting and starts or stops the route now. Turning it off also
   * removes the account's route, which disconnects the server. Refuses, changing
   * nothing, while this machine's own bot is the official application.
   */
  setEnabled(
    enabled: boolean,
    guard: () => Promise<void>,
  ): Promise<OfficialDiscordBodyStatus | OfficialDiscordBodyRefusal> {
    const run = async () => (enabled ? this.turnOn(guard) : this.turnOff(guard));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async turnOn(
    guard: () => Promise<void>,
  ): Promise<OfficialDiscordBodyStatus | OfficialDiscordBodyRefusal> {
    const account = this.options.account;
    if (account === undefined)
      return {
        error: "not_signed_in",
        detail: "Sign in to your Clankie account first: clankie remote-access on.",
      };
    let official: OfficialDiscordStatus;
    try {
      official = OfficialDiscordStatusSchema.parse(
        await this.fleet(account, OFFICIAL_DISCORD_PATHS.status, "GET"),
      );
    } catch (error) {
      return { error: "fleet_unavailable", detail: `Clankie account: ${errorCode(error)}` };
    }
    // One gateway connection per bot token: a bring-your-own bot stays on its own
    // token, but this machine must not also run the official application's token.
    const discord = (await this.options.settings.load()).discord;
    if (
      official.applicationId !== undefined &&
      discord.applicationId === official.applicationId &&
      discord.activeBody === "bot"
    )
      return {
        error: "official_application_is_local_bot",
        detail:
          "This machine's own Discord bot is the official Clankie application. Stop its direct bridge first (clankie discord clear --application-id and remove the bot token in /discord), so only the hosted edge holds that token.",
      };
    await this.options.settings.update(
      (value) => ({ ...value, discord: { ...value.discord, officialBotEnabled: true } }),
      guard,
    );
    if (!this.ingress) {
      this.ingress = this.options.open(account);
      // The first attempt answers this request; failures keep retrying in the background.
      await this.ingress.register();
    }
    return this.status();
  }
  private async turnOff(guard: () => Promise<void>): Promise<OfficialDiscordBodyStatus> {
    await this.options.settings.update(
      (value) => ({ ...value, discord: { ...value.discord, officialBotEnabled: false } }),
      guard,
    );
    this.close();
    const account = this.options.account;
    if (account === undefined) return this.status();
    // Removing the route disconnects the server and deletes the edge's buffered chat.
    let fleetError: string | undefined;
    try {
      await this.fleet(account, OFFICIAL_DISCORD_PATHS.unregister, "POST");
    } catch (error) {
      fleetError = `unregister_failed:${errorCode(error)}`.slice(0, 200);
    }
    const status = await this.status();
    return fleetError === undefined ? status : { ...status, fleetError };
  }
  private async fleet(account: OfficialDiscordAccountRoute, path: string, method: "GET" | "POST") {
    const { token } = await account.resolveAccountToken();
    const response = await (this.options.fetchImpl ?? fetch)(
      new URL(path, hostedOrigin(account.gatewayUrl)),
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = (body as { error?: unknown } | undefined)?.error;
      throw new Error(typeof code === "string" ? code : `http_${String(response.status)}`);
    }
    return body;
  }
}

function errorCode(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 120) || "unknown";
}
