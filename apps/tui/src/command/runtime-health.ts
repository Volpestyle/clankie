import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  RUNTIME_HEALTH_PATH,
  RuntimeHealthPatchSchema,
  RuntimeHealthSnapshotSchema,
  type RuntimeHealthSettings,
  type RuntimeHealthSnapshot,
  type RuntimeHealthObservation,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

const USAGE =
  "Usage: clankie runtime-health [status|on|off|set --cpu-percent N --health-ms N --sustained-seconds N --sample-seconds N --cooldown-seconds N]";
export interface RuntimeHealthCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}
export function parseRuntimeHealthArgs(args: readonly string[]): Partial<RuntimeHealthSettings> | undefined {
  const verb = args[0] ?? "status";
  if (args.length <= 1 && verb === "status") return undefined;
  if (args.length === 1 && (verb === "on" || verb === "off")) return { enabled: verb === "on" };
  if (verb !== "set" || args.length < 3 || args.length % 2 !== 1) throw new Error(USAGE);
  const flags = {
    "--cpu-percent": ["cpuPercent", 1],
    "--health-ms": ["healthLatencyMs", 1],
    "--sustained-seconds": ["sustainedMs", 1000],
    "--sample-seconds": ["sampleIntervalMs", 1000],
    "--cooldown-seconds": ["cooldownMs", 1000],
  } as const;
  const changes: Partial<RuntimeHealthSettings> = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index] as keyof typeof flags;
    const specification = flags[flag];
    if (
      !specification ||
      changes[specification[0]] !== undefined ||
      !/^(?:\d+)(?:\.\d+)?$/u.test(args[index + 1]!)
    )
      throw new Error(USAGE);
    changes[specification[0]] = Number(args[index + 1]) * specification[1];
  }
  RuntimeHealthPatchSchema.parse(changes);
  return changes;
}
export async function runRuntimeHealthCommand(
  args: readonly string[],
  options: RuntimeHealthCommandOptions = {},
): Promise<RuntimeHealthSnapshot> {
  const changes = parseRuntimeHealthArgs(args);
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Operator credential unavailable; run clankie doctor.");
  const request = async (body?: unknown) => {
    const response = await (options.fetchImpl ?? fetch)(
      `${commandHost(options).replace(/\/+$/u, "")}${RUNTIME_HEALTH_PATH}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error(`Runtime health unavailable (${response.status}); run clankie doctor.`);
    return RuntimeHealthSnapshotSchema.parse(await response.json());
  };
  const current = await request();
  return changes === undefined
    ? current
    : request({ schemaVersion: 1, expectedRevision: current.revision, changes });
}
export function formatRuntimeHealth(observation: RuntimeHealthObservation): string {
  return `Runtime health: ${observation.state} · CPU ${observation.cpuPercent === undefined ? "unknown" : `${observation.cpuPercent}%`} · /health ${observation.healthLatencyMs === undefined ? "unknown" : `${observation.healthLatencyMs}ms`}${observation.healthAvailable === false ? " unavailable" : ""} · held ${observation.durationMs}ms${observation.lastIncidentDurationMs === undefined ? "" : ` · last incident ${observation.lastIncidentDurationMs}ms`}`;
}
