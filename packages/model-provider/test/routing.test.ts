import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogSchema } from "@clankie/model-registry";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ClankieConfigSchema, type ClankieConfig } from "../src/config.ts";
import { resolvePiModelSelection } from "../src/pi.ts";
import {
  configForRef,
  DEFAULT_ROUTINE_TURN_LIMIT,
  MODEL_PURPOSES,
  routeFor,
  updateModelRouting,
} from "../src/routing.ts";

const WORK = "openai/work-model";
const ROUTINE = "openai/routine-model";

const routed: ClankieConfig = { model: WORK, routing: { routine_model: ROUTINE } };

describe("routeFor", () => {
  it("keeps every purpose on the one captain model until a routine model is set", () => {
    for (const config of [{ model: WORK }, { model: WORK, routing: { escalate: true } }] as ClankieConfig[]) {
      for (const purpose of MODEL_PURPOSES) {
        expect(routeFor(config, purpose)).toEqual({ purpose, tier: "work", ref: WORK });
      }
    }
  });

  it("routes only social Discord to the routine model by default", () => {
    expect(
      Object.fromEntries(MODEL_PURPOSES.map((purpose) => [purpose, routeFor(routed, purpose).ref])),
    ).toEqual({
      operator: WORK,
      discord_social: ROUTINE,
      discord_granted: WORK,
      gameplay: WORK,
    });
  });

  it("applies per-purpose overrides in both directions", () => {
    const config: ClankieConfig = {
      ...routed,
      routing: { routine_model: ROUTINE, purposes: { gameplay: "routine", discord_social: "work" } },
    };
    expect(routeFor(config, "gameplay")).toMatchObject({ tier: "routine", ref: ROUTINE });
    expect(routeFor(config, "discord_social")).toMatchObject({ tier: "work", ref: WORK });
  });

  it("offers escalation only on routine routes, and only when the owner turned it on", () => {
    expect(routeFor(routed, "discord_social").escalation).toBeUndefined();
    const escalating: ClankieConfig = { ...routed, routing: { routine_model: ROUTINE, escalate: true } };
    expect(routeFor(escalating, "discord_social").escalation).toEqual({
      ref: WORK,
      turnLimit: DEFAULT_ROUTINE_TURN_LIMIT,
    });
    expect(routeFor(escalating, "operator").escalation).toBeUndefined();
    const elsewhere: ClankieConfig = {
      ...routed,
      routing: {
        routine_model: ROUTINE,
        escalate: true,
        escalation_model: "clankie/escalation",
        routine_turn_limit: 4,
      },
    };
    expect(routeFor(elsewhere, "discord_social").escalation).toEqual({
      ref: "clankie/escalation",
      turnLimit: 4,
    });
  });

  it("points only `model` at the routed ref, so every other policy still applies", () => {
    const config: ClankieConfig = { ...routed, disabled_providers: ["xai"], variant: { [ROUTINE]: "low" } };
    expect(configForRef(config, ROUTINE)).toEqual({ ...config, model: ROUTINE });
    expect(configForRef(config, WORK)).toBe(config);
    expect(configForRef(config, undefined)).toBe(config);
  });
});

describe("routine resolution never falls back to the work model", () => {
  const model = (id: string) =>
    ({
      id,
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.example/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_000,
    }) as Model<Api>;
  const runtime = (models: readonly Model<Api>[]) => ({
    getModel: (providerId: string, modelId: string) =>
      models.find((entry) => entry.provider === providerId && entry.id === modelId),
    getModels: (providerId: string) => models.filter((entry) => entry.provider === providerId),
  });
  const catalog = CatalogSchema.parse({});

  it("selects the routine model for a routine purpose", () => {
    const selection = resolvePiModelSelection(
      configForRef(routed, routeFor(routed, "discord_social").ref),
      runtime([model("work-model"), model("routine-model")]),
      { hasCodexSubscription: false, catalog },
    );
    expect(selection.ref).toBe(ROUTINE);
  });

  it("fails by name when the routine model cannot be served", () => {
    expect(() =>
      resolvePiModelSelection(
        configForRef(routed, routeFor(routed, "discord_social").ref),
        runtime([model("work-model")]),
        { hasCodexSubscription: false, catalog },
      ),
    ).toThrow(/openai\/routine-model/u);
  });

  it("fails when the routine model's provider is disabled rather than using another", () => {
    expect(() =>
      resolvePiModelSelection(
        configForRef({ ...routed, disabled_providers: ["openai"] }, ROUTINE),
        runtime([model("work-model"), model("routine-model")]),
        { hasCodexSubscription: false, catalog },
      ),
    ).toThrow(/disabled/u);
  });
});

describe("updateModelRouting", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  async function env(): Promise<NodeJS.ProcessEnv> {
    const dir = await mkdtemp(join(tmpdir(), "clankie-routing-"));
    dirs.push(dir);
    return { XDG_CONFIG_HOME: dir };
  }
  async function stored(environment: NodeJS.ProcessEnv): Promise<ClankieConfig> {
    const path = join(environment.XDG_CONFIG_HOME ?? "", "clankie", "clankie.json");
    return ClankieConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  }

  it("writes, overrides and clears routing without touching the captain model", async () => {
    const environment = await env();
    await updateModelRouting({ routineModel: "openai/routine-model" }, { env: environment });
    await updateModelRouting(
      {
        escalate: true,
        escalationModel: "openai/big",
        routineTurnLimit: 6,
        purposes: { gameplay: "routine" },
      },
      { env: environment },
    );
    expect((await stored(environment)).routing).toEqual({
      routine_model: "openai/routine-model",
      escalate: true,
      escalation_model: "openai/big",
      routine_turn_limit: 6,
      purposes: { gameplay: "routine" },
    });

    await updateModelRouting(
      { routineModel: null, escalationModel: null, routineTurnLimit: null, purposes: { gameplay: null } },
      { env: environment },
    );
    expect((await stored(environment)).routing).toEqual({ escalate: true });
    expect((await stored(environment)).model).toBeUndefined();
  });

  it("refuses malformed refs and limits before writing anything", async () => {
    const environment = await env();
    await expect(updateModelRouting({ routineModel: "no-slash" }, { env: environment })).rejects.toThrow(
      /routine model/u,
    );
    await expect(updateModelRouting({ routineTurnLimit: 0 }, { env: environment })).rejects.toThrow(
      /turn limit/u,
    );
  });
});
