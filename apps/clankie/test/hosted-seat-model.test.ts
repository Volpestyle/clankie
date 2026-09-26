import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hostedPiSeatModel } from "../src/hosted-seat-model.ts";

async function withConfig(config: Record<string, unknown>, run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "hosted-seat-"));
  try {
    mkdirSync(join(dir, "clankie"), { recursive: true });
    writeFileSync(join(dir, "clankie", "clankie.json"), JSON.stringify(config));
    await run({ XDG_CONFIG_HOME: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const included = {
  npm: "@ai-sdk/openai",
  options: { baseURL: "http://127.0.0.1:4319/v1" },
  models: { default: { limit: { context: 272_000, output: 8_192 } } },
};

describe("a hosted body's pi worker model (VUH-1373)", () => {
  it("is the included model through the body's forwarder on included usage, with no key", async () => {
    await withConfig({ model: "clankie/default", provider: { clankie: included } }, async (env) => {
      const seat = await hostedPiSeatModel({ env });
      expect(seat?.model).toBe("clankie/default");
      expect(seat?.provider).toMatchObject({
        id: "clankie",
        config: { baseUrl: "http://127.0.0.1:4319/v1", api: "openai-responses", apiKey: "local" },
      });
      const config = seat?.provider?.config as
        | { models: { id: string; contextWindow: number; maxTokens: number }[] }
        | undefined;
      const models = config?.models ?? [];
      expect(models.map((model) => model.id)).toEqual(["default", "routine", "escalation"]);
      expect(models[0]).toMatchObject({ contextWindow: 272_000, maxTokens: 8_192 });
      expect(JSON.stringify(seat)).not.toMatch(/sk-/u);
    });
  });

  it("is the customer's own model on their credential", async () => {
    await withConfig({ model: "openai/gpt-6-luna", provider: { clankie: included } }, async (env) => {
      expect(await hostedPiSeatModel({ env })).toEqual({ model: "openai/gpt-6-luna" });
    });
  });

  it("reaches the customer's model through the body's loopback when one is offered", async () => {
    await withConfig({ model: "openai/gpt-6-luna", provider: { clankie: included } }, async (env) => {
      const seat = { model: "clankie-customer/gpt-6-luna" };
      const customer = vi.fn(async () => seat);
      expect(await hostedPiSeatModel({ env, customer })).toBe(seat);
      expect(customer).toHaveBeenCalledWith("http://127.0.0.1:4319/customer");
      // No loopback seat (say, a subscription token without an account id): the plain model.
      expect(await hostedPiSeatModel({ env, customer: async () => undefined })).toEqual({
        model: "openai/gpt-6-luna",
      });
    });
  });

  it("is nothing off a hosted body", async () => {
    await withConfig({ model: "openai/gpt-6-luna" }, async (env) => {
      expect(await hostedPiSeatModel({ env })).toBeUndefined();
    });
  });
});
