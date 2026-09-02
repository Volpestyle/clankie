import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  beginClankieAccountLogin,
  completeClankieAccountLogin,
  generatePublicGatewayInstallationId,
  type CredentialStore,
} from "@clankie/credential-broker";
import { PublicGatewaySettingsSchema, SettingsStore } from "@clankie/settings";
import { gatewayConfigure, gatewayDisable, gatewayStatus } from "./command/gateway.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export function buildGatewayCommands(services: {
  readonly settings: SettingsStore;
  readonly credentials: CredentialStore;
  readonly restartGateway?: () => Promise<void>;
}): FaceShellCommand[] {
  return [
    {
      name: "gateway",
      aliases: [],
      description: "Connect this Mac to Clankie's public doorway",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "status") {
          await showStatus(shell, services);
          return;
        }
        await runWizard(shell, services);
      },
    },
  ];
}

async function showStatus(
  shell: ClankieFaceShell,
  services: { readonly settings: SettingsStore; readonly credentials: CredentialStore },
): Promise<void> {
  const status = await gatewayStatus(services);
  shell.insertCommandResult(
    "/gateway status",
    [
      `doorway: ${status.enabled ? "ready" : "disabled"}`,
      `url: ${status.publicGateway.url ?? "—"}`,
      `host id: ${status.hostId ?? "—"}`,
      `host credential: ${status.credentialPresent ? "stored" : "missing"}`,
      `settings file: ${status.settingsFile}`,
    ].join("\n"),
    "success",
  );
}

async function runWizard(
  shell: ClankieFaceShell,
  services: {
    readonly settings: SettingsStore;
    readonly credentials: CredentialStore;
    readonly restartGateway?: () => Promise<void>;
  },
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("gateway");
  try {
    const current = await gatewayStatus(services);
    const action = await flow.readSelect({
      message: "Public doorway",
      options: [
        { value: "configure", label: "Enable remote access", hint: "email + one-time code" },
        { value: "status", label: "Show status" },
        ...(current.publicGateway.url === undefined
          ? []
          : [{ value: "disable", label: "Sign out and disable" }]),
      ],
    });
    if (action === "status") {
      await showStatus(shell, services);
      return;
    }
    if (action === "disable") {
      await gatewayDisable(services);
      await services.restartGateway?.();
      flow.renderLine("Remote access disabled and this Mac signed out.", "success");
      return;
    }
    if (action !== "configure") return;

    const gatewayUrl = current.publicGateway.url ?? "https://api.clankie.bot";
    const email = await flow.readText({
      message: "Clankie account email",
      validate: (value) =>
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim()) ? undefined : "Enter a valid email address.",
    });
    if (email === undefined) return;
    flow.setStatus("sending a one-time code…");
    const challenge = await beginClankieAccountLogin({ gatewayUrl, email });
    const code = await flow.readText({
      message: "Six-digit code from your email",
      validate: (value) => (/^\d{6}$/u.test(value.trim()) ? undefined : "Enter the six-digit code."),
    });
    if (code === undefined) return;
    flow.setStatus("signing this Mac in…");
    const credential = await completeClankieAccountLogin({ challenge, code });

    const installationId = current.publicGateway.installationId ?? generatePublicGatewayInstallationId();
    const publicGateway = PublicGatewaySettingsSchema.parse({ url: gatewayUrl, installationId });
    await services.credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, credential);
    await services.credentials.delete(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID);
    await gatewayConfigure(publicGateway, services);
    flow.setStatus("starting remote access…");
    await services.restartGateway?.();
    flow.renderLine("Remote access is ready. Run /pair to connect your phone.", "success");
  } finally {
    flow.end();
  }
}
