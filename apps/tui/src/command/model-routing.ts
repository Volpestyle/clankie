import {
  DEFAULT_ROUTINE_TURN_LIMIT,
  isModelPurpose,
  isModelTier,
  loadConfig,
  MODEL_PURPOSES,
  routeFor,
  routingEnabled,
  updateModelRouting,
  type ModelPurpose,
  type ModelRoutingUpdate,
  type ModelTier,
} from "@clankie/model-provider";

export const MODEL_ROUTING_USAGE = [
  "Usage: clankie model routing [status]",
  "       clankie model routing set providerId/modelId",
  "       clankie model routing off",
  "       clankie model routing escalate on|off [--model providerId/modelId]",
  `       clankie model routing purpose ${MODEL_PURPOSES.join("|")} routine|work|default`,
  "       clankie model routing turn-limit N|default",
].join("\n");

export interface ModelRoutingOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ModelRoutingStatus {
  readonly ok: boolean;
  readonly enabled: boolean;
  readonly routineModel: string | null;
  readonly workModel: string | null;
  readonly escalate: boolean;
  readonly escalationModel: string | null;
  readonly routineTurnLimit: number;
  readonly purposes: Record<
    ModelPurpose,
    { readonly tier: ModelTier; readonly model: string | null; readonly escalatesTo?: string }
  >;
  readonly issues?: readonly { path: string; message: string }[];
}

/**
 * What every purpose runs on, from the same resolver the service uses per
 * turn — so this card and a turn can never disagree about a model.
 */
export async function modelRoutingStatus(options: ModelRoutingOptions = {}): Promise<ModelRoutingStatus> {
  const { config, issues } = await loadConfig(options);
  const routing = config.routing ?? {};
  const enabled = routingEnabled(config);
  const purposes = Object.fromEntries(
    MODEL_PURPOSES.map((purpose) => {
      const route = routeFor(config, purpose);
      return [
        purpose,
        {
          tier: route.tier,
          model: route.ref ?? null,
          ...(route.escalation === undefined ? {} : { escalatesTo: route.escalation.ref }),
        },
      ];
    }),
  ) as ModelRoutingStatus["purposes"];
  return {
    ok: issues.length === 0,
    enabled,
    routineModel: routing.routine_model ?? null,
    workModel: config.model ?? null,
    escalate: routing.escalate === true,
    escalationModel: routing.escalation_model ?? config.model ?? null,
    routineTurnLimit: routing.routine_turn_limit ?? DEFAULT_ROUTINE_TURN_LIMIT,
    purposes,
    ...(issues.length === 0 ? {} : { issues }),
  };
}

async function modelRoutingUpdate(
  update: ModelRoutingUpdate,
  options: ModelRoutingOptions = {},
): Promise<ModelRoutingStatus> {
  await updateModelRouting(update, options.env === undefined ? {} : { env: options.env });
  return await modelRoutingStatus(options);
}

function parseUpdate(args: readonly string[]): ModelRoutingUpdate {
  const [verb, first, second, third] = args;
  if (verb === "set" && first !== undefined && args.length === 2) return { routineModel: first };
  if (verb === "off" && args.length === 1) return { routineModel: null };
  if (verb === "escalate" && (first === "on" || first === "off")) {
    if (args.length === 2) return { escalate: first === "on" };
    if (args.length === 4 && second === "--model" && third !== undefined && first === "on") {
      return { escalate: true, escalationModel: third };
    }
  }
  if (verb === "purpose" && first !== undefined && second !== undefined && args.length === 3) {
    if (!isModelPurpose(first))
      throw new Error(`Unknown purpose ${JSON.stringify(first)}.\n\n${MODEL_ROUTING_USAGE}`);
    if (second === "default") return { purposes: { [first]: null } };
    if (!isModelTier(second))
      throw new Error(`Unknown tier ${JSON.stringify(second)}.\n\n${MODEL_ROUTING_USAGE}`);
    return { purposes: { [first]: second } };
  }
  if (verb === "turn-limit" && first !== undefined && args.length === 2) {
    if (first === "default") return { routineTurnLimit: null };
    return { routineTurnLimit: Number(first) };
  }
  throw new Error(MODEL_ROUTING_USAGE);
}

export async function runModelRoutingCommand(
  args: readonly string[],
  options: ModelRoutingOptions = {},
): Promise<ModelRoutingStatus> {
  if (args.length === 0 || (args[0] === "status" && args.length === 1))
    return await modelRoutingStatus(options);
  return await modelRoutingUpdate(parseUpdate(args), options);
}
