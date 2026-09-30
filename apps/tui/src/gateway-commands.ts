import { accountHasHostedClankie, pairHostedAccount } from "./hosted-session.ts";
import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  beginClankieAccountLogin,
  completeClankieAccountLogin,
  generatePublicGatewayInstallationId,
  type CredentialStore,
} from "@clankie/credential-broker";
import { DeviceDirectRouteSchema } from "@clankie/protocol";
import { PublicGatewaySettingsSchema, SettingsStore } from "@clankie/settings";
import {
  gatewayConfigure,
  gatewayConfigureDirect,
  gatewayDisable,
  gatewayStatus,
  runGatewayCommand,
  type GatewayCommandResult,
} from "./command/gateway.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export function buildGatewayCommands(services: {
  readonly settings: SettingsStore;
  readonly credentials: CredentialStore;
  readonly restartGateway?: () => Promise<void>;
}): FaceShellCommand[] {
  return [
    {
      name: "remote-access",
      aliases: ["gateway"],
      description: "Remote access for this Mac (self-host only)",
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
    "/remote-access status",
    [
      `doorway: ${doorwayLine(status)}`,
      `url: ${status.publicGateway.url ?? "—"}`,
      `host id: ${status.hostId ?? "—"}`,
      `direct control: ${status.directRoute?.controlPlaneUrl ?? "not configured"}`,
      `direct relay: ${status.directRoute?.relayUrl ?? "not configured"}`,
      `host credential: ${status.credentialPresent ? "stored" : "missing"}`,
      `settings file: ${status.settingsFile}`,
    ].join("\n"),
    "success",
  );
}

/** Configured is not open: the live state is the one that answers "can my phone reach him". */
function doorwayLine(status: GatewayCommandResult): string {
  if (!status.enabled) return "disabled";
  switch (status.doorway.state) {
    case "sign_in_required":
      return `signed out since ${status.doorway.since} — run /remote-access to sign this Mac back in`;
    case "connected":
      return "open";
    case "connecting":
      return "configured, reconnecting";
    case "unavailable":
      return "configured, but Clankie holds no connection — check his log, then `clankie restart captain`";
    case "disabled":
      return "configured, not started";
    case "unreachable":
      return "configured; Clankie is not answering";
  }
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
      message: "Remote access for this Mac",
      options: [
        { value: "configure", label: "Enable remote access", hint: "email + one-time code" },
        { value: "status", label: "Show status" },
        { value: "direct", label: "Configure direct fallback", hint: "private network endpoints" },
        {
          value: "rotate",
          label: "Rotate encryption key",
          hint: "re-pair devices after restarting the captain",
        },
        ...(current.publicGateway.url === undefined
          ? []
          : [{ value: "disable", label: "Sign out and disable" }]),
      ],
    });
    if (action === "status") {
      await showStatus(shell, services);
      return;
    }
    if (action === "direct") {
      const validateOrigin = (value: string) =>
        DeviceDirectRouteSchema.safeParse({ controlPlaneUrl: value.trim(), relayUrl: value.trim() }).success
          ? undefined
          : "Enter a direct http(s) origin without a path, credentials, query, or fragment.";
      const controlPlaneUrl = await flow.readText({
        message: "Device-reachable control plane URL (usually port 4310)",
        validate: validateOrigin,
      });
      if (controlPlaneUrl === undefined) return;
      const relayUrl = await flow.readText({
        message: "Device-reachable relay URL (usually port 4321)",
        validate: validateOrigin,
      });
      if (relayUrl === undefined) return;
      await gatewayConfigureDirect(
        { controlPlaneUrl: controlPlaneUrl.trim(), relayUrl: relayUrl.trim() },
        services,
      );
      await services.restartGateway?.();
      flow.renderLine(
        "Direct fallback saved. Open the app once through the gateway to learn these endpoints.",
        "success",
      );
      return;
    }
    if (action === "rotate") {
      await runGatewayCommand(["rotate-encryption-key"], services);
      flow.renderLine(
        "Encryption key rotated. Restart the captain, then run /pair for each device.",
        "success",
      );
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
      message: "Code from your email",
      validate: (value) => (/^\d+$/u.test(value.trim()) ? undefined : "Enter the numeric code."),
    });
    if (code === undefined) return;
    flow.setStatus("signing this Mac in…");
    const credential = await completeClankieAccountLogin({ challenge, code });

    if (await accountHasHostedClankie(gatewayUrl, credential)) {
      const action = await flow.readSelect({
        message: "Your account already has a hosted Clankie",
        options: [
          { value: "hosted", label: "Connect to it" },
          { value: "cancel", label: "Cancel" },
        ],
      });
      if (action === "hosted") {
        await pairHostedAccount({
          gatewayUrl,
          credential,
          store: services.credentials,
          settings: services.settings,
        });
        flow.renderLine("Hosted connection saved. Exit this console and run clankie again.", "success");
      }
      return;
    }

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
