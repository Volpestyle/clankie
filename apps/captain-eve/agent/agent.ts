import { resolve } from "node:path";
import {
  ConfiguredModelError,
  createLanguageModel,
  loadConfig,
  parseModelRef,
  resolveConfiguredLanguageModel,
  type ConfiguredLanguageModel,
} from "@clankie/model-provider";
import { defineAgent, defineDynamic, type AgentModelOptionsDefinition } from "eve";
import { mockModel } from "eve/evals";
import { admittedCaptainModel } from "../lib/lanes/runtime.ts";
import { compactionContextWindow, contextBudget } from "../lib/session/context-budget.ts";
import { rememberModelSelection } from "../lib/session/model-selection.ts";
import { protectRecentToolResultModel, recentToolResultState } from "../lib/session/recent-tool-results.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const testModelOverride =
  process.env.NODE_ENV === "test" ? process.env.CAPTAIN_TEST_MODEL?.trim() : undefined;
const testModelDelayMs =
  testModelOverride === undefined ? 0 : parseTestModelDelay(process.env.CAPTAIN_TEST_MODEL_DELAY_MS);
const testModel =
  testModelOverride === undefined
    ? undefined
    : testModelDelayMs === 0
      ? testModelOverride
      : mockModel(async () => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, testModelDelayMs));
          return "RESTART_DRILL_MODEL_REPLY";
        });
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

function stepIndex(event: unknown): number {
  if (
    event !== null &&
    typeof event === "object" &&
    "data" in event &&
    event.data !== null &&
    typeof event.data === "object" &&
    "stepIndex" in event.data &&
    typeof event.data.stepIndex === "number"
  ) {
    return event.data.stepIndex;
  }
  throw new ConfiguredModelError("Eve step event did not include a step index");
}

function parseTestModelDelay(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 60_000) {
    throw new ConfiguredModelError("CAPTAIN_TEST_MODEL_DELAY_MS must be an integer from 0 to 60000");
  }
  return parsed;
}

const model =
  testModel !== undefined
    ? testModel
    : defineDynamic({
        fallback: failClosedModel as NonNullable<typeof failClosedModel>,
        events: {
          "step.started": async (event, ctx) => {
            const turnId = stepTurnId(event);
            const selected = await modelForTurn(ctx.session.id, turnId);
            const modelOptions = eveModelOptions(selected);
            const budget =
              selected.modelContextWindowTokens === undefined
                ? undefined
                : contextBudget(selected.modelContextWindowTokens, selected.modelMaxOutputTokens);
            rememberModelSelection(ctx.session.id, turnId, {
              ref: selected.ref,
              ...(budget === undefined ? {} : { budget }),
            });
            const protectedToolResults = recentToolResultState.get().protected;
            const admitted = await admittedCaptainModel({
              selected,
              channel: ctx.channel,
              sessionId: ctx.session.id,
              turnId,
              stepIndex: stepIndex(event),
            });
            return {
              model: protectRecentToolResultModel(admitted, protectedToolResults),
              ...(budget === undefined ? {} : { modelContextWindowTokens: compactionContextWindow(budget) }),
              ...(modelOptions === undefined ? {} : { modelOptions }),
            };
          },
        },
      });

export default defineAgent({
  model,
  ...(testModelDelayMs === 0 ? {} : { modelContextWindowTokens: 128_000 }),
  // Dynamic model selections report the usable boundary (adjusted for Eve's
  // strict threshold comparison) instead of the provider's full window. The
  // operator UI independently keeps showing the registry's full context.
  compaction: { thresholdPercent: 1 },
  build: {
    externalDependencies: [
      "@clankie/credential-broker",
      "@clankie/model-provider",
      "@clankie/model-registry",
    ],
  },
});
