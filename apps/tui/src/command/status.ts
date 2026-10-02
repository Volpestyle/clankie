import { inspectOperatorCredential, type OperatorCredentialStatus } from "@clankie/credential-broker";
import { createServiceOptions, inspectServices, type CreateServiceOptionsInput } from "../../bin/services.ts";
import { SERVICE_ORDER, type ServiceStatus } from "../../bin/service-supervisor.ts";
import { DEFAULT_CONTROL_PLANE_URL } from "../../bin/pairing-offer.ts";
import { nextStepLine } from "../next-step.ts";
import { DeviceDirectRouteSchema } from "@clankie/protocol";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { probeDoorway, type GatewayDoorwayReport } from "./gateway.ts";
import { hostedWhoami } from "./hosted.ts";

export interface StatusCommandOptions extends CreateServiceOptionsInput {
  readonly host?: string;
}

export interface StatusCommandResult {
  readonly ok: boolean;
  readonly status: string;
  readonly host: string;
  readonly owned?: boolean;
  readonly pid?: number;
  readonly operatorCredential:
    | OperatorCredentialStatus
    | { readonly present: false; readonly source: "none"; readonly consistency: "invalid" };
  readonly services: readonly ServiceStatus[];
  /** Which machine and access this terminal uses: what `whoami` reports. */
  readonly connection?: unknown;
  /** Live remote-access doorway for phone pairing (absent when settings cannot be read). */
  readonly doorway?: GatewayDoorwayReport;
  readonly nextStep?: string;
}

export async function statusCommand(options: StatusCommandOptions): Promise<StatusCommandResult> {
  const env = options.env ?? process.env;
  let operatorCredential: StatusCommandResult["operatorCredential"];
  try {
    operatorCredential = await inspectOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
  } catch {
    operatorCredential = { present: false, source: "none", consistency: "invalid" };
  }
  const operatorCredentialHealthy =
    operatorCredential.present && operatorCredential.consistency !== "mismatch";
  const services = await inspectServices(SERVICE_ORDER, await createServiceOptions(options));
  const clankie = services.find((service) => service.id === "clankie");
  const serviceHealthy = clankie?.state === "healthy";
  const access = await phoneAccess(options, env, serviceHealthy);
  return {
    ok: serviceHealthy && operatorCredentialHealthy,
    status: !serviceHealthy
      ? (clankie?.state ?? "unreachable")
      : operatorCredentialHealthy
        ? "ready"
        : `operator_credential_${operatorCredential.consistency}`,
    host:
      options.host ?? env.CLANKIE_CONTROL_PLANE_URL ?? env.CLANKIE_CAPTAIN_URL ?? DEFAULT_CONTROL_PLANE_URL,
    ...(clankie === undefined ? {} : { owned: clankie.owned }),
    ...(clankie?.pid === undefined ? {} : { pid: clankie.pid }),
    operatorCredential,
    services,
    ...access,
  };
}

/**
 * Advisory context beside the service state; a settings or probe failure never
 * fails `status`. It reads settings and the loopback doorway only, never the
 * credential store, so a status check cannot prompt for the Keychain.
 */
async function phoneAccess(
  options: StatusCommandOptions,
  env: NodeJS.ProcessEnv,
  serviceHealthy: boolean,
): Promise<Pick<StatusCommandResult, "connection" | "doorway" | "nextStep">> {
  try {
    const settings = await new SettingsStore(defaultSettingsPath(env)).load();
    const connection = await hostedWhoami(env);
    // A service that is not healthy has no doorway to ask; skip the round trip.
    const doorway: GatewayDoorwayReport = serviceHealthy
      ? await probeDoorway({
          env,
          ...(options.host === undefined ? {} : { host: options.host }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        })
      : { state: "unreachable" };
    return {
      connection,
      doorway,
      nextStep: nextStepLine({
        doorway,
        remoteAccessConfigured: settings.publicGateway.url !== undefined,
        directRouteConfigured: DeviceDirectRouteSchema.safeParse({
          controlPlaneUrl: settings.relay.controlPlaneUrl,
          relayUrl: settings.relay.url,
        }).success,
      }),
    };
  } catch {
    return {};
  }
}
