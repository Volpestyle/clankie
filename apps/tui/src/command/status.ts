import { inspectOperatorCredential, type OperatorCredentialStatus } from "@clankie/credential-broker";
import { createServiceOptions, inspectServices, type CreateServiceOptionsInput } from "../../bin/services.ts";
import { SERVICE_ORDER, type ServiceStatus } from "../../bin/service-supervisor.ts";
import { DEFAULT_CONTROL_PLANE_URL } from "../../bin/pairing-offer.ts";

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
  };
}
