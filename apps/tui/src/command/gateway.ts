import { randomBytes } from "node:crypto";
import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID,
  createDefaultCredentialStore,
  derivePublicGatewayHostId,
  generatePublicGatewayInstallationId,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { HostPowerReportSchema, type HostPowerReport } from "@clankie/protocol/host-power";
import {
  PublicGatewayDoorwayStateSchema,
  type PublicGatewayDoorwayState,
} from "@clankie/protocol/public-gateway";
import {
  PublicGatewaySettingsSchema,
  SettingsStore,
  defaultSettingsPath,
  type PublicGatewaySettings,
} from "@clankie/settings";
import { z } from "zod";
import { DeviceDirectRouteSchema, type DeviceDirectRoute } from "@clankie/protocol";
import { commandHost } from "./io.ts";

const DOORWAY_PROBE_TIMEOUT_MS = 5_000;
const HealthSchema = z.object({ doorway: PublicGatewayDoorwayStateSchema.optional() }).passthrough();

/** Configuration says a doorway should exist; this says whether one is open. */
export type GatewayDoorwayReport = PublicGatewayDoorwayState | { readonly state: "unreachable" };

const GATEWAY_USAGE = [
  "Usage: clankie remote-access [status]",
  "       clankie remote-access on [--email EMAIL --code-stdin]",
  "       clankie remote-access off | rotate-key",
  "       clankie gateway [status]",
  "       clankie gateway set --url URL --host-id ID",
  "       clankie gateway direct --control-plane-url URL --relay-url URL",
  "       clankie gateway disable",
  "       clankie gateway rotate-encryption-key",
  "Enter the host bearer with the interactive /gateway wizard; secrets are never flags.",
].join("\n");

export interface GatewayCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
  readonly credentials?: CredentialStore;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface GatewayCommandResult {
  readonly ok: true;
  readonly publicGateway: PublicGatewaySettings;
  readonly directRoute?: DeviceDirectRoute;
  readonly credentialPresent: boolean;
  readonly enabled: boolean;
  readonly hostId?: string;
  readonly settingsFile: string;
  readonly restart: string;
  /** Live, from the running captain: stored settings never prove the socket is up. */
  readonly doorway: GatewayDoorwayReport;
}

function stores(options: GatewayCommandOptions): {
  readonly settings: SettingsStore;
  readonly credentials: CredentialStore;
} {
  const env = options.env ?? process.env;
  return {
    settings: options.settings ?? new SettingsStore(defaultSettingsPath(env)),
    credentials: options.credentials ?? createDefaultCredentialStore({ env }),
  };
}

async function result(options: GatewayCommandOptions): Promise<GatewayCommandResult> {
  const { settings, credentials } = stores(options);
  const stored = await settings.load();
  const publicGateway = stored.publicGateway;
  const directRoute = DeviceDirectRouteSchema.safeParse({
    controlPlaneUrl: stored.relay.controlPlaneUrl,
    relayUrl: stored.relay.url,
  });
  const listed = await credentials.list();
  const account = await credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID);
  const accountReady =
    publicGateway.installationId !== undefined &&
    account?.type === "oauth" &&
    account.accountId !== undefined;
  const legacyReady =
    publicGateway.hostId !== undefined && listed[PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID] !== undefined;
  const hostId = accountReady
    ? derivePublicGatewayHostId(account.accountId ?? "", publicGateway.installationId ?? "")
    : publicGateway.hostId;
  const credentialPresent = accountReady || legacyReady;
  return {
    ok: true,
    publicGateway,
    ...(directRoute.success ? { directRoute: directRoute.data } : {}),
    credentialPresent,
    enabled: publicGateway.url !== undefined && credentialPresent,
    ...(hostId === undefined ? {} : { hostId }),
    settingsFile: settings.path,
    restart: "clankie restart captain",
    doorway: await probeDoorway(options),
  };
}

/**
 * Reads the captain's own view over loopback. A captain that is down, or older
 * than this field, reads `unreachable` rather than borrowing the stored
 * credential's word for it.
 */
export async function probeDoorway(options: GatewayCommandOptions = {}): Promise<GatewayDoorwayReport> {
  return (await probeHealth(options)).doorway;
}

/**
 * One read of the captain's `/health`: the doorway, and the last time the host
 * slept underneath him (which only he can notice). Either is absent when he is
 * down or older than the field.
 */
export async function probeHealth(
  options: GatewayCommandOptions = {},
): Promise<{ readonly doorway: GatewayDoorwayReport; readonly lastSleep?: HostPowerReport["lastSleep"] }> {
  const env = options.env ?? process.env;
  const url = `${commandHost({ ...options, env }).replace(/\/+$/u, "")}/health`;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(DOORWAY_PROBE_TIMEOUT_MS),
    });
    const body = HealthSchema.safeParse(await response.json());
    if (!body.success || body.data.doorway === undefined) return { doorway: { state: "unreachable" } };
    const power = HostPowerReportSchema.safeParse(body.data.power);
    return {
      doorway: body.data.doorway,
      ...(power.success && power.data.lastSleep !== undefined ? { lastSleep: power.data.lastSleep } : {}),
    };
  } catch {
    return { doorway: { state: "unreachable" } };
  }
}

export async function gatewayConfigure(
  publicGateway: PublicGatewaySettings,
  options: GatewayCommandOptions = {},
): Promise<GatewayCommandResult> {
  const parsed = PublicGatewaySettingsSchema.parse(publicGateway);
  const { settings } = stores(options);
  await settings.update((current) => ({ ...current, publicGateway: parsed }));
  return await result(options);
}

export async function gatewayConfigureDirect(
  route: DeviceDirectRoute,
  options: GatewayCommandOptions = {},
): Promise<GatewayCommandResult> {
  const parsed = DeviceDirectRouteSchema.parse(route);
  await stores(options).settings.update((current) => ({
    ...current,
    relay: { ...current.relay, controlPlaneUrl: parsed.controlPlaneUrl, url: parsed.relayUrl },
  }));
  return await result(options);
}

/**
 * Stores a signed-in Clankie account as this Mac's remote-access credential and
 * points settings at the gateway. `/remote-access`, `clankie login` and
 * `clankie remote-access on` all end here, so a signed-out Mac re-signs in
 * under the same installation id and keeps its host id. The captain still has
 * to restart to open the doorway.
 */
export async function gatewayEnableWithAccount(
  input: {
    readonly gatewayUrl: string;
    readonly credential: Extract<ProviderCredential, { type: "oauth" }>;
  },
  options: GatewayCommandOptions = {},
): Promise<GatewayCommandResult> {
  const { settings, credentials } = stores(options);
  const current = (await settings.load()).publicGateway;
  const publicGateway = PublicGatewaySettingsSchema.parse({
    url: input.gatewayUrl,
    installationId: current.installationId ?? generatePublicGatewayInstallationId(),
  });
  await credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, input.credential);
  await credentials.delete(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID);
  return await gatewayConfigure(publicGateway, options);
}

export async function gatewayDisable(options: GatewayCommandOptions = {}): Promise<GatewayCommandResult> {
  const { settings, credentials } = stores(options);
  await settings.update((current) => ({ ...current, publicGateway: {} }));
  await credentials.delete(CLANKIE_ACCOUNT_PROVIDER_ID);
  await credentials.delete(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID);
  return await result(options);
}

export async function gatewayStatus(options: GatewayCommandOptions = {}): Promise<GatewayCommandResult> {
  return await result(options);
}

export async function runGatewayCommand(
  args: readonly string[],
  options: GatewayCommandOptions = {},
): Promise<GatewayCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await gatewayStatus(options);
  if ((verb === "rotate-encryption-key" || verb === "rotate-key") && args.length === 1) {
    await stores(options).credentials.set(PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID, {
      type: "api",
      key: randomBytes(32).toString("hex"),
    });
    return await result(options);
  }
  if ((verb === "disable" || verb === "off") && args.length === 1) return await gatewayDisable(options);
  if (verb === "direct" && args.length === 5) {
    const values = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (!name || !value || (name !== "--control-plane-url" && name !== "--relay-url") || values.has(name))
        throw new Error(GATEWAY_USAGE);
      values.set(name, value);
    }
    const controlPlaneUrl = values.get("--control-plane-url");
    const relayUrl = values.get("--relay-url");
    if (!controlPlaneUrl || !relayUrl) throw new Error(GATEWAY_USAGE);
    return await gatewayConfigureDirect({ controlPlaneUrl, relayUrl }, options);
  }
  if (verb === "set" && args.length === 5) {
    const values = new Map<string, string>();
    for (let index = 1; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (name === undefined || value === undefined || (name !== "--url" && name !== "--host-id")) {
        throw new Error(GATEWAY_USAGE);
      }
      values.set(name, value);
    }
    const url = values.get("--url");
    const hostId = values.get("--host-id");
    if (url === undefined || hostId === undefined) throw new Error(GATEWAY_USAGE);
    return await gatewayConfigure({ url, hostId }, options);
  }
  throw new Error(GATEWAY_USAGE);
}
