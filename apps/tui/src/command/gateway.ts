import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  createDefaultCredentialStore,
  derivePublicGatewayHostId,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  PublicGatewaySettingsSchema,
  SettingsStore,
  defaultSettingsPath,
  type PublicGatewaySettings,
} from "@clankie/settings";

const GATEWAY_USAGE = [
  "Usage: clankie gateway [status]",
  "       clankie gateway set --url URL --host-id ID",
  "       clankie gateway disable",
  "Enter the host bearer with the interactive /gateway wizard; secrets are never flags.",
].join("\n");

export interface GatewayCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
  readonly credentials?: CredentialStore;
}

export interface GatewayCommandResult {
  readonly ok: true;
  readonly publicGateway: PublicGatewaySettings;
  readonly credentialPresent: boolean;
  readonly enabled: boolean;
  readonly hostId?: string;
  readonly settingsFile: string;
  readonly restart: string;
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
  const publicGateway = (await settings.load()).publicGateway;
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
    credentialPresent,
    enabled: publicGateway.url !== undefined && credentialPresent,
    ...(hostId === undefined ? {} : { hostId }),
    settingsFile: settings.path,
    restart: "clankie restart captain",
  };
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
  if (verb === "disable" && args.length === 1) return await gatewayDisable(options);
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
