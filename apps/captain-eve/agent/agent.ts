import { resolve } from "node:path";
import {
  ConfiguredModelError,
  createLanguageModel,
  loadConfig,
  parseModelRef,
  resolveConfiguredLanguageModel,
  type ConfiguredLanguageModel,
} from "@sapling/model-provider";
import { defineAgent, defineDynamic, type AgentModelOptionsDefinition } from "eve";

const repoRoot = resolve(import.meta.dirname, "../../..");
const testModelOverride =
  process.env.NODE_ENV === "test" ? process.env.CAPTAIN_TEST_MODEL?.trim() : undefined;
const configured = await loadConfig({ cwd: repoRoot });
const configuredRef =
  configured.config.model === undefined ? undefined : parseModelRef(configured.config.model);
if ((testModelOverride === undefined || testModelOverride.length === 0) && configuredRef === undefined) {
  throw new ConfiguredModelError("No captain model is configured; run /model");
}

const failClosedModel =
  configuredRef === undefined
    ? undefined
    : createLanguageModel({
        provider: {
          id: configuredRef.providerId,
          name: configuredRef.providerId,
          env: [],
          models: {},
        },
        modelId: configuredRef.modelId,
        env: {},
        fetchImpl: async () => {
          throw new ConfiguredModelError(
            `Dynamic captain model resolution failed for ${configured.config.model ?? "the configured model"}`,
          );
        },
      });

function eveModelOptions(selected: ConfiguredLanguageModel): AgentModelOptionsDefinition | undefined {
  const providerOptions = selected.modelOptions?.providerOptions;
  return providerOptions === undefined
    ? undefined
    : ({ providerOptions } as unknown as AgentModelOptionsDefinition);
}

const MAX_PINNED_TURNS = 128;
const modelsByTurn = new Map<string, Promise<ConfiguredLanguageModel>>();

function modelForTurn(sessionId: string, turnId: string): Promise<ConfiguredLanguageModel> {
  const key = `${sessionId}:${turnId}`;
  const existing = modelsByTurn.get(key);
  if (existing !== undefined) return existing;
  if (modelsByTurn.size >= MAX_PINNED_TURNS) {
    const oldest = modelsByTurn.keys().next().value as string | undefined;
    if (oldest !== undefined) modelsByTurn.delete(oldest);
  }
  const resolution = resolveConfiguredLanguageModel({ cwd: repoRoot, sessionId }).catch((error: unknown) => {
    modelsByTurn.delete(key);
    throw error;
  });
  modelsByTurn.set(key, resolution);
  return resolution;
}

function stepTurnId(event: unknown): string {
  if (
    event !== null &&
    typeof event === "object" &&
    "data" in event &&
    event.data !== null &&
    typeof event.data === "object" &&
    "turnId" in event.data &&
    typeof event.data.turnId === "string"
  ) {
    return event.data.turnId;
  }
  throw new ConfiguredModelError("Eve step event did not include a turn id; refusing to switch models");
}

const model =
  testModelOverride !== undefined && testModelOverride.length > 0
    ? (testModelOverride as string)
    : defineDynamic({
        fallback: failClosedModel as NonNullable<typeof failClosedModel>,
        events: {
          "step.started": async (event, ctx) => {
            const selected = await modelForTurn(ctx.session.id, stepTurnId(event));
            const modelOptions = eveModelOptions(selected);
            return {
              model: selected.model,
              ...(selected.modelContextWindowTokens === undefined
                ? {}
                : { modelContextWindowTokens: selected.modelContextWindowTokens }),
              ...(modelOptions === undefined ? {} : { modelOptions }),
            };
          },
        },
      });

export default defineAgent({
  model,
  compaction: { thresholdPercent: 0.9 },
  build: {
    externalDependencies: [
      "@sapling/credential-broker",
      "@sapling/model-provider",
      "@sapling/model-registry",
    ],
  },
  limits: {
    maxSubagentDepth: 2,
    maxSubagents: 12,
  },
});
