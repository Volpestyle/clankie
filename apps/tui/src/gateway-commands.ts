import { PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID, type CredentialStore } from "@clankie/credential-broker";
import { PublicGatewaySettingsSchema, SettingsStore } from "@clankie/settings";
import { gatewayConfigure, gatewayDisable, gatewayStatus } from "./command/gateway.ts";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export function buildGatewayCommands(services: {
  readonly settings: SettingsStore;
  readonly credentials: CredentialStore;
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
      `host id: ${status.publicGateway.hostId ?? "—"}`,
      `host credential: ${status.credentialPresent ? "stored" : "missing"}`,
      `settings file: ${status.settingsFile}`,
    ].join("\n"),
    "success",
  );
}

async function runWizard(
  shell: ClankieFaceShell,
  services: { readonly settings: SettingsStore; readonly credentials: CredentialStore },
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("gateway");
  try {
    const current = await gatewayStatus(services);
    const action = await flow.readSelect({
      message: "Public doorway",
      options: [
        { value: "configure", label: "Configure", hint: "AWS URL, host id, bearer" },
        { value: "status", label: "Show status" },
        ...(current.publicGateway.url === undefined ? [] : [{ value: "disable", label: "Disable" }]),
      ],
    });
    if (action === "status") {
      await showStatus(shell, services);
      return;
    }
    if (action === "disable") {
      await gatewayDisable(services);
      flow.renderLine("Public doorway disabled and its host credential removed.", "success");
      return;
    }
    if (action !== "configure") return;

    const url = await flow.readText({
      message: "Gateway URL",
      defaultValue: current.publicGateway.url ?? "https://api.clankie.bot",
      validate: (value) => (value.trim().length === 0 ? "Gateway URL is required." : undefined),
    });
    if (url === undefined) return;
    const hostId = await flow.readText({
      message: "Host id from the AWS deployment",
      defaultValue: current.publicGateway.hostId ?? "",
      validate: (value) =>
        /^[A-Za-z0-9_-]{16,128}$/u.test(value.trim()) ? undefined : "Use 16–128 letters, digits, _ or -.",
    });
    if (hostId === undefined) return;
    const token = await flow.readSecret({
      message: "Host bearer from the AWS deployment",
      validate: (value) => {
        const length = value.trim().length;
        return length >= 32 && length <= 512 ? undefined : "The host bearer must be 32–512 characters.";
      },
    });
    if (token === undefined) return;

    const publicGateway = PublicGatewaySettingsSchema.parse({ url: url.trim(), hostId: hostId.trim() });
    await services.credentials.set(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID, { type: "api", key: token.trim() });
    await gatewayConfigure(publicGateway, services);
    flow.renderLine("Public doorway configured. Restart Clankie to connect.", "success");
  } finally {
    flow.end();
  }
}
