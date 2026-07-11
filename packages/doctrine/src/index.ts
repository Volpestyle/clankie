import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ActionDecision,
  ActionEffect,
  ActionRequest,
  ExecutionClass,
  Risk,
  TaskKind,
} from "@sapling/protocol";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const RiskOrder: Record<Risk, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export const ConnectorRiskClassSchema = z.enum([
  "read",
  "reversible-write",
  "irreversible-write",
  "publish-external",
  "destructive",
]);
export type ConnectorRiskClass = z.infer<typeof ConnectorRiskClassSchema>;

export const AuthorityBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operator") }),
  z.object({ kind: z.literal("local"), source: z.string().min(1) }),
  z.object({ kind: z.literal("connector"), connector: z.string().min(1) }),
]);
export type AuthorityBinding = z.infer<typeof AuthorityBindingSchema>;
const AuthorityBindingInputSchema = z.union([
  AuthorityBindingSchema,
  z
    .string()
    .min(1)
    .transform((connector): AuthorityBinding => ({ kind: "connector", connector })),
]);

const ActionRuleSchema = z.object({
  id: z.string().min(1),
  effect: z.enum(["allow", "deny", "require_approval"]),
  when: z
    .object({
      maxRisk: z.enum(["low", "medium", "high", "critical"]).optional(),
      minHumanApprovals: z.number().int().nonnegative().optional(),
      checksPassed: z.boolean().optional(),
      maxChangedLines: z.number().int().nonnegative().optional(),
      environments: z.array(z.string()).optional(),
      repositories: z.array(z.string()).optional(),
      excludePaths: z.array(z.string()).optional(),
    })
    .default({}),
  obligations: z.array(z.string()).default([]),
  reason: z.string().min(1),
});

const ActionPolicySchema = z.object({
  default: z.enum(["allow", "deny", "require_approval"]),
  rules: z.array(ActionRuleSchema).default([]),
});

export const OrchestrationProfileSchema = z.object({
  schemaVersion: z.literal("1"),
  id: z.string().min(1),
  description: z.string().min(1),
  kind: z.enum(["preset", "internal", "overlay"]).optional(),
  ceremony: z
    .object({
      externalConnectors: z.enum(["none", "optional", "required"]),
      integrationFlow: z.enum(["direct_main", "pull_request", "review_gate"]),
    })
    .optional(),
  planning: z.object({
    requirePlanApproval: z.boolean().default(true),
    scopeExpansion: z.enum(["forbid", "ask", "small_adjacent", "broad"]).default("ask"),
    targetReviewMinutes: z.number().int().positive().default(20),
    softChangedLines: z.number().int().positive().default(300),
    hardChangedLines: z.number().int().positive().default(800),
    maxLogicalConcernsPerPr: z.number().int().positive().default(1),
  }),
  topology: z.object({
    maxParallelWorkers: z.number().int().positive().default(3),
    maxDelegationDepth: z.number().int().nonnegative().default(2),
    defaultExecution: z.enum([
      "eve_subagent",
      "runner_visible",
      "runner_headless",
      "human_owned",
      "automatic",
    ]),
    route: z
      .array(
        z.object({
          kinds: z.array(
            z.enum([
              "context",
              "planning",
              "research",
              "design",
              "implementation",
              "debugging",
              "verification",
              "review",
              "integration",
              "deployment",
              "evaluation",
            ]),
          ),
          execution: z.enum([
            "eve_subagent",
            "runner_visible",
            "runner_headless",
            "human_owned",
            "automatic",
          ]),
        }),
      )
      .default([]),
  }),
  verification: z.object({
    independentVerifier: z.boolean().default(true),
    differentHarnessPreferred: z.boolean().default(true),
    requireEvidence: z.boolean().default(true),
    requiredChecks: z.array(z.string()).default(["typecheck", "unit"]),
  }),
  budgets: z.object({
    maxMissionCostUsd: z.number().nonnegative().default(10),
    maxTaskRetries: z.number().int().nonnegative().default(1),
    maxMissionWallMinutes: z.number().int().positive().default(120),
  }),
  authority: z.record(z.string(), AuthorityBindingInputSchema).default({}),
  riskClasses: z.record(ConnectorRiskClassSchema, ActionPolicySchema).optional(),
  actions: z.record(z.string(), ActionPolicySchema).default({}),
  memory: z.object({
    rawTranscriptRetentionDays: z.number().int().nonnegative().default(7),
    inferredFacts: z.enum(["deny", "require_approval", "allow"]).default("require_approval"),
    publicToPrivatePropagation: z.boolean().default(false),
  }),
});

export type OrchestrationProfile = z.infer<typeof OrchestrationProfileSchema>;
export const DoctrineOverlaySchema = OrchestrationProfileSchema.partial().extend({
  schemaVersion: z.literal("1"),
  id: z.string().min(1),
  description: z.string().min(1),
  kind: z.literal("overlay"),
  ceremony: z.never().optional(),
  authority: z.never().optional(),
});
export type DoctrineOverlay = z.infer<typeof DoctrineOverlaySchema>;
export type DoctrineLayer = Partial<OrchestrationProfile> | DoctrineOverlay;
const ActionClassificationBrand = Symbol("trusted-connector-action-classification");
export interface ActionClassification {
  action: string;
  riskClass: ConnectorRiskClass;
  readonly [ActionClassificationBrand]: true;
}
export interface ConnectorActionMetadata {
  action: string;
  riskClass: ConnectorRiskClass;
}
export type ConnectorActionMetadataClassifier = (action: string) => ActionClassification | undefined;

export function createConnectorActionClassifier(
  metadata: readonly ConnectorActionMetadata[],
): ConnectorActionMetadataClassifier {
  const byAction = new Map<string, ConnectorRiskClass>();
  for (const entry of metadata) {
    const action = z.string().min(1).parse(entry.action);
    const riskClass = ConnectorRiskClassSchema.parse(entry.riskClass);
    if (byAction.has(action)) throw new Error(`Duplicate connector action metadata for ${action}`);
    byAction.set(action, riskClass);
  }
  return (action) => {
    const riskClass = byAction.get(action);
    return riskClass ? { action, riskClass, [ActionClassificationBrand]: true } : undefined;
  };
}

export interface CompiledDoctrine {
  profile: OrchestrationProfile;
  profileHash: string;
  plannerCard: string;
  scheduler: {
    maxParallelWorkers: number;
    maxTaskRetries: number;
    maxMissionWallMinutes: number;
  };
  routing: Record<TaskKind, ExecutionClass>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function mergeObjects(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) return override;
  if (override && typeof override === "object" && base && typeof base === "object" && !Array.isArray(base)) {
    const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
      result[key] = mergeObjects(result[key], value);
    }
    return result;
  }
  return override === undefined ? base : override;
}

function preserveHigherScopeDenies(
  current: OrchestrationProfile | undefined,
  merged: OrchestrationProfile,
): OrchestrationProfile {
  if (!current) return merged;
  const actions = { ...merged.actions };
  for (const [action, policy] of Object.entries(current.actions)) {
    if (policy.default === "deny") {
      actions[action] = policy;
    }
  }
  const riskClasses: OrchestrationProfile["riskClasses"] = merged.riskClasses
    ? { ...merged.riskClasses }
    : undefined;
  for (const [riskClass, policy] of Object.entries(current.riskClasses ?? {})) {
    if (policy.default === "deny" && riskClasses) {
      riskClasses[riskClass as ConnectorRiskClass] = policy;
    }
  }
  return { ...merged, actions, riskClasses };
}

function applyLayer(current: OrchestrationProfile | undefined, layer: DoctrineLayer): unknown {
  if (layer.kind !== "overlay") return mergeObjects(current ?? {}, layer);
  if (!current) throw new Error("A doctrine overlay requires a base preset");
  const {
    schemaVersion: _schemaVersion,
    id: _id,
    description: _description,
    kind: _kind,
    ceremony: _ceremony,
    authority: _authority,
    ...tightening
  } = layer;
  return mergeObjects(current, tightening);
}

export function compileDoctrine(layers: DoctrineLayer[]): CompiledDoctrine {
  if (layers.length === 0) throw new Error("At least one doctrine layer is required");

  let parsed: OrchestrationProfile | undefined;
  for (const layer of layers) {
    const next = OrchestrationProfileSchema.parse(applyLayer(parsed, layer));
    parsed = preserveHigherScopeDenies(parsed, next);
  }
  if (!parsed) throw new Error("Doctrine compilation produced no profile");
  if (!parsed.verification.independentVerifier) {
    throw new Error("The invariant floor requires an independent verifier");
  }

  const allKinds: TaskKind[] = [
    "context",
    "planning",
    "research",
    "design",
    "implementation",
    "debugging",
    "verification",
    "review",
    "integration",
    "deployment",
    "evaluation",
  ];
  const routing = Object.fromEntries(
    allKinds.map((kind) => [kind, parsed.topology.defaultExecution]),
  ) as Record<TaskKind, ExecutionClass>;
  for (const rule of parsed.topology.route) {
    for (const kind of rule.kinds) routing[kind] = rule.execution;
  }

  const profileHash = createHash("sha256").update(stableJson(parsed)).digest("hex").slice(0, 16);
  const plannerCard = [
    `Doctrine: ${parsed.id}`,
    `PR target: <=${parsed.planning.softChangedLines} changed lines; hard limit ${parsed.planning.hardChangedLines}.`,
    `Scope expansion: ${parsed.planning.scopeExpansion}.`,
    `Parallel workers: ${parsed.topology.maxParallelWorkers}; delegation depth: ${parsed.topology.maxDelegationDepth}.`,
    `Independent verification: ${parsed.verification.independentVerifier ? "required" : "optional"}.`,
    `Mission budget: $${parsed.budgets.maxMissionCostUsd}; wall time: ${parsed.budgets.maxMissionWallMinutes} minutes.`,
  ].join("\n");

  return {
    profile: parsed,
    profileHash,
    plannerCard,
    scheduler: {
      maxParallelWorkers: parsed.topology.maxParallelWorkers,
      maxTaskRetries: parsed.budgets.maxTaskRetries,
      maxMissionWallMinutes: parsed.budgets.maxMissionWallMinutes,
    },
    routing,
  };
}

function globPrefixMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
  return pattern === path;
}

function matchesRule(request: ActionRequest, rule: z.infer<typeof ActionRuleSchema>): boolean {
  const when = rule.when;
  if (when.maxRisk && RiskOrder[request.context.risk] > RiskOrder[when.maxRisk]) return false;
  if (
    when.minHumanApprovals !== undefined &&
    (request.context.humanApprovals ?? 0) < when.minHumanApprovals
  ) {
    return false;
  }
  if (when.checksPassed !== undefined && request.context.checksPassed !== when.checksPassed) return false;
  if (when.maxChangedLines !== undefined && (request.context.changedLines ?? 0) > when.maxChangedLines)
    return false;
  if (when.environments && !when.environments.includes(request.resource.environment ?? "")) return false;
  if (when.repositories && !when.repositories.includes(request.resource.repository ?? "")) return false;
  if (
    when.excludePaths &&
    (request.context.changedPaths ?? []).some((path) =>
      when.excludePaths?.some((pattern) => globPrefixMatches(pattern, path)),
    )
  ) {
    return false;
  }
  return true;
}

function decidePolicy(
  request: ActionRequest,
  policy: z.infer<typeof ActionPolicySchema>,
  policyId: string,
): ActionDecision {
  for (const rule of policy.rules) {
    if (matchesRule(request, rule)) {
      return {
        effect: rule.effect,
        reason: rule.reason,
        matchedPolicyIds: [rule.id],
        obligations: rule.obligations,
      };
    }
  }

  return {
    effect: policy.default,
    reason: `Default policy for ${policyId}.`,
    matchedPolicyIds: [`${policyId}:default`],
    obligations: [],
  };
}

function applyInvariantFloor(
  request: ActionRequest,
  classification: ActionClassification | undefined,
  decision: ActionDecision,
): ActionDecision {
  if (request.action === "test.integrity.weaken" && decision.effect !== "deny") {
    return {
      effect: "deny",
      reason: `${decision.reason} The invariant floor forbids weakening test integrity.`,
      matchedPolicyIds: [...decision.matchedPolicyIds, "invariant-floor:test-integrity"],
      obligations: decision.obligations,
    };
  }
  const requiresApproval =
    request.action === "deployment.production.create" ||
    request.action === "shell.destructive" ||
    classification?.riskClass === "publish-external" ||
    classification?.riskClass === "destructive";
  if (!requiresApproval || isAtLeastAsRestrictive("require_approval", decision.effect)) return decision;

  return {
    effect: "require_approval",
    reason: `${decision.reason} The invariant floor requires human approval.`,
    matchedPolicyIds: [...decision.matchedPolicyIds, "invariant-floor:human-approval"],
    obligations: decision.obligations,
  };
}

export function decideAction(
  doctrine: CompiledDoctrine,
  request: ActionRequest,
  classification?: ActionClassification,
): ActionDecision {
  if (
    classification &&
    (classification[ActionClassificationBrand] !== true || classification.action !== request.action)
  ) {
    return {
      effect: "deny",
      reason: "Connector risk classification is untrusted or belongs to a different action.",
      matchedPolicyIds: ["untrusted-action-classification"],
      obligations: [],
    };
  }
  const policy = doctrine.profile.actions[request.action];
  if (policy) {
    return applyInvariantFloor(request, classification, decidePolicy(request, policy, request.action));
  }

  if (classification) {
    const classPolicy = doctrine.profile.riskClasses?.[classification.riskClass];
    if (classPolicy) {
      return applyInvariantFloor(
        request,
        classification,
        decidePolicy(request, classPolicy, `risk-class:${classification.riskClass}`),
      );
    }
  }

  return applyInvariantFloor(request, classification, {
    effect: "deny",
    reason: `No policy grants ${request.action}; deny by default.`,
    matchedPolicyIds: ["implicit-deny"],
    obligations: [],
  });
}

/**
 * Evaluates a worker's request for a connector capability. Capabilities are
 * never issued on behalf of captains, humans, or system principals, and the
 * caller must treat every result other than `allow` as a refusal to mint.
 */
export function decideCapabilityRequest(
  doctrine: CompiledDoctrine,
  request: ActionRequest,
  classification?: ActionClassification,
): ActionDecision {
  if (request.principal.kind !== "worker") {
    return {
      effect: "deny",
      reason: "Connector capabilities may only be issued to authenticated worker runs.",
      matchedPolicyIds: ["capability-worker-only"],
      obligations: [],
    };
  }
  return decideAction(doctrine, request, classification);
}

export function resolveAuthorityBinding(
  doctrine: CompiledDoctrine,
  role: string,
  connectedConnectors: ReadonlySet<string> = new Set(),
): AuthorityBinding {
  const binding = doctrine.profile.authority[role];
  if (!binding) throw new Error(`No authority binding is configured for ${role}`);
  if (binding.kind === "connector" && !connectedConnectors.has(binding.connector)) {
    throw new Error(`Authority role ${role} requires connector ${binding.connector}`);
  }
  return binding;
}

/** The capability gateway's single grant condition. */
export function permitsCapabilityGrant(decision: ActionDecision): boolean {
  return decision.effect === "allow";
}

export async function loadDoctrineFile(path: string): Promise<OrchestrationProfile> {
  const raw = await readFile(path, "utf8");
  return OrchestrationProfileSchema.parse(parseYaml(raw));
}

export async function loadDoctrineLayerFile(path: string): Promise<OrchestrationProfile | DoctrineOverlay> {
  const raw = parseYaml(await readFile(path, "utf8"));
  if (raw && typeof raw === "object" && (raw as { kind?: unknown }).kind === "overlay") {
    return DoctrineOverlaySchema.parse(raw);
  }
  return OrchestrationProfileSchema.parse(raw);
}

export function isAtLeastAsRestrictive(previous: ActionEffect, next: ActionEffect): boolean {
  const order: Record<ActionEffect, number> = { allow: 0, require_approval: 1, deny: 2 };
  return order[next] >= order[previous];
}
