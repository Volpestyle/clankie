import { parseModelRef, updateGlobalConfig, type ClankieConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Task-based model routing. Every model call Clankie makes has a purpose, and
// each purpose runs on one of two tiers: `work`, the owner's chosen `model`,
// or `routine`, a cheap model for turns that are conversation rather than
// work. Routing is off until `routing.routine_model` is set; off, every purpose
// resolves to `model` exactly as before routing existed.
//
// The rules are fixed and legible — a purpose table, not a classifier. The
// one judgment left to a model is his own: a routine turn that turns out to be
// real work may escalate itself (see the captain's routing extension).
// ---------------------------------------------------------------------------

/**
 * The kinds of model call the service makes.
 *
 * - `operator`: operator conversations, including their wakes, watches and
 *   side conversations — the console, the app, the seat.
 * - `discord_social`: a Discord text or voice turn without machine tools.
 * - `discord_granted`: a Discord turn holding machine tools (a machine grant,
 *   an owner DM, a trusted guild), and the Herdr watches such a turn arms.
 * - `gameplay`: the play mind and its commentary.
 */
export const MODEL_PURPOSES = ["operator", "discord_social", "discord_granted", "gameplay"] as const;
export type ModelPurpose = (typeof MODEL_PURPOSES)[number];

export const MODEL_TIERS = ["routine", "work"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/**
 * Which tier each purpose runs on once routing is on. Only social Discord is
 * routine by default: it is where most turns are small talk, and a turn there
 * holds no shell to do real work with. Gameplay stays on the work model until
 * the play evaluation says a cheap model plays well enough.
 */
export const DEFAULT_PURPOSE_TIERS: Readonly<Record<ModelPurpose, ModelTier>> = {
  operator: "work",
  discord_social: "routine",
  discord_granted: "work",
  gameplay: "work",
};

/** Model calls one routine run may make before it counts as looping and escalates. */
export const DEFAULT_ROUTINE_TURN_LIMIT = 12;

export function isModelPurpose(value: string): value is ModelPurpose {
  return (MODEL_PURPOSES as readonly string[]).includes(value);
}

export function isModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

export interface ModelEscalation {
  /** The model an escalated routine run continues on. */
  readonly ref: string;
  /** Model calls before a routine run escalates as looping. */
  readonly turnLimit: number;
}

export interface ModelRoute {
  readonly purpose: ModelPurpose;
  readonly tier: ModelTier;
  /** The configured ref this purpose runs on; undefined only when no captain model is chosen. */
  readonly ref: string | undefined;
  /** Present only for a routine route whose owner turned escalation on. */
  readonly escalation?: ModelEscalation;
}

/** Routing is on when a routine model is configured. */
export function routingEnabled(config: ClankieConfig): boolean {
  return (config.routing?.routine_model ?? "").length > 0;
}

export function purposeTier(config: ClankieConfig, purpose: ModelPurpose): ModelTier {
  if (!routingEnabled(config)) return "work";
  return config.routing?.purposes?.[purpose] ?? DEFAULT_PURPOSE_TIERS[purpose];
}

/**
 * Which model a purpose runs on. A routine route never falls back to the work
 * model when its own ref is unusable: the caller resolves the routine ref and
 * fails by name, so a broken routine setting surfaces instead of quietly
 * spending the expensive model.
 */
export function routeFor(config: ClankieConfig, purpose: ModelPurpose): ModelRoute {
  const tier = purposeTier(config, purpose);
  if (tier === "work") return { purpose, tier, ref: config.model };
  const routing = config.routing ?? {};
  const escalationRef = routing.escalation_model ?? config.model;
  return {
    purpose,
    tier,
    ref: routing.routine_model,
    ...(routing.escalate === true && escalationRef !== undefined
      ? {
          escalation: {
            ref: escalationRef,
            turnLimit: routing.routine_turn_limit ?? DEFAULT_ROUTINE_TURN_LIMIT,
          },
        }
      : {}),
  };
}

/**
 * The config a model resolver should read for one ref: the same config with
 * `model` pointed at it. Every resolver already selects from `model` (with
 * subscription precedence, provider policy and per-ref effort), so a routed
 * ref goes through exactly the same checks as the captain's own.
 */
export function configForRef(config: ClankieConfig, ref: string | undefined): ClankieConfig {
  return ref === undefined || ref === config.model ? config : { ...config, model: ref };
}

// ---------------------------------------------------------------------------
// Writers — global config only, like every other `clankie model` writer.
// ---------------------------------------------------------------------------

function normalizedRef(ref: string, label: string): string {
  const parsed = parseModelRef(ref);
  if (parsed === undefined)
    throw new Error(`Invalid ${label} ${JSON.stringify(ref)}; expected providerId/modelId.`);
  return `${parsed.providerId}/${parsed.modelId}`;
}

function withoutEmpty(routing: NonNullable<ClankieConfig["routing"]>): ClankieConfig["routing"] {
  const next = { ...routing };
  if (next.purposes !== undefined && Object.keys(next.purposes).length === 0) delete next.purposes;
  return Object.keys(next).length === 0 ? undefined : next;
}

export interface ModelRoutingUpdate {
  /** A ref turns routing on; null removes the routine model, which turns routing off. */
  readonly routineModel?: string | null;
  readonly escalate?: boolean;
  /** A ref, or null to escalate to `model`. */
  readonly escalationModel?: string | null;
  readonly routineTurnLimit?: number | null;
  /** A tier, or null to return that purpose to its default. */
  readonly purposes?: Partial<Record<ModelPurpose, ModelTier | null>>;
}

export async function updateModelRouting(
  update: ModelRoutingUpdate,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<ClankieConfig> {
  const routineModel =
    update.routineModel === undefined || update.routineModel === null
      ? update.routineModel
      : normalizedRef(update.routineModel, "routine model");
  const escalationModel =
    update.escalationModel === undefined || update.escalationModel === null
      ? update.escalationModel
      : normalizedRef(update.escalationModel, "escalation model");
  if (
    update.routineTurnLimit !== undefined &&
    update.routineTurnLimit !== null &&
    (!Number.isInteger(update.routineTurnLimit) || update.routineTurnLimit <= 0)
  ) {
    throw new Error("The routine turn limit must be a positive whole number.");
  }
  return await updateGlobalConfig((current) => {
    const routing = { ...current.routing };
    if (routineModel === null) delete routing.routine_model;
    else if (routineModel !== undefined) routing.routine_model = routineModel;
    if (update.escalate !== undefined) routing.escalate = update.escalate;
    if (escalationModel === null) delete routing.escalation_model;
    else if (escalationModel !== undefined) routing.escalation_model = escalationModel;
    if (update.routineTurnLimit === null) delete routing.routine_turn_limit;
    else if (update.routineTurnLimit !== undefined) routing.routine_turn_limit = update.routineTurnLimit;
    if (update.purposes !== undefined) {
      const purposes = { ...routing.purposes };
      for (const [purpose, tier] of Object.entries(update.purposes)) {
        if (tier === null) delete purposes[purpose];
        else if (tier !== undefined) purposes[purpose] = tier;
      }
      routing.purposes = purposes;
    }
    const next = withoutEmpty(routing);
    if (next === undefined) delete current.routing;
    else current.routing = next;
  }, options);
}
