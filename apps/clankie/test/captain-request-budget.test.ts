import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  captainRequestExtension,
  fitRequestBytes,
  INCLUDED_USAGE_REQUEST_BUDGET_BYTES,
  lanePromptCacheKey,
  OMITTED_IMAGE_TEXT,
  promptCacheSalt,
  TRIMMED_OUTPUT_TEXT,
  withLaneCache,
} from "../src/captain/request-budget.ts";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const image = (kb: number) => ({
  type: "input_image",
  image_url: `data:image/png;base64,${"A".repeat(kb * 1024)}`,
});

describe("lane prompt cache", () => {
  it("replaces Pi's per-session key with one stable key per install and lane", () => {
    const key = lanePromptCacheKey("0123456789ab", "operator");
    expect(key).toBe("clankie-0123456789ab-operator");
    expect(withLaneCache({ model: "gpt-6-luna", prompt_cache_key: "session-1" }, key)).toEqual({
      model: "gpt-6-luna",
      prompt_cache_key: key,
    });
  });

  it("asks for 24-hour retention only on models OpenAI lists for it", () => {
    expect(withLaneCache({ model: "gpt-5.4", prompt_cache_key: "s" }, "k")).toMatchObject({
      prompt_cache_retention: "24h",
    });
    // gpt-6-luna is GPT-5.6+, which keeps a prefix for 30 minutes and is not on the list.
    expect(withLaneCache({ model: "gpt-6-luna", prompt_cache_key: "s" }, "k")).not.toHaveProperty(
      "prompt_cache_retention",
    );
    expect(withLaneCache({ model: "default", prompt_cache_key: "s" }, "k")).not.toHaveProperty(
      "prompt_cache_retention",
    );
  });

  it("leaves a transport that sends no cache key alone", () => {
    const payload = { model: "claude", messages: [] };
    expect(withLaneCache(payload, "k")).toBe(payload);
  });

  it("keeps one salt per install across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-cache-salt-"));
    try {
      const path = join(dir, "nested", "prompt-cache-salt");
      const salt = promptCacheSalt(path);
      expect(salt).toMatch(/^[0-9a-f]{12}$/u);
      expect(promptCacheSalt(path)).toBe(salt);
      expect(readFileSync(path, "utf8").trim()).toBe(salt);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("included-usage request budget", () => {
  it("is about 1.8 MiB, under the proxy's 2 MiB", () => {
    expect(INCLUDED_USAGE_REQUEST_BUDGET_BYTES).toBeLessThan(2 * 1024 * 1024);
    expect(INCLUDED_USAGE_REQUEST_BUDGET_BYTES).toBeGreaterThan(1.75 * 1024 * 1024);
  });

  it("sends a request under budget untouched", () => {
    const payload = { input: [{ role: "user", content: [image(10)] }] };
    expect(fitRequestBytes(payload)).toEqual({ payload, trimmed: 0 });
  });

  it("drops older images first and keeps the newest message's", () => {
    const payload = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }, image(700)] },
        { role: "user", content: [image(700)] },
        { role: "user", content: [{ type: "input_text", text: "what is this?" }, image(700)] },
      ],
    };
    const fitted = fitRequestBytes(payload);
    expect(bytes(fitted.payload)).toBeLessThanOrEqual(INCLUDED_USAGE_REQUEST_BUDGET_BYTES);
    const input = fitted.payload.input as Array<{ content: Array<{ type: string; text?: string }> }>;
    expect(input[0]?.content[1]).toEqual({ type: "input_text", text: OMITTED_IMAGE_TEXT });
    expect(input[2]?.content[1]?.type).toBe("input_image");
    expect(payload.input[0]?.content[1]).toMatchObject({ type: "input_image" });
  });

  it("trims older outsized tool output to its head and tail, then the newest if it must", () => {
    const big = (fill: string) => `START-${fill.repeat(900 * 1024)}-END`;
    const payload = {
      input: [
        { type: "function_call_output", call_id: "a", output: big("a") },
        { type: "function_call_output", call_id: "b", output: big("b") },
        { type: "function_call_output", call_id: "c", output: big("c") },
      ],
    };
    const fitted = fitRequestBytes(payload);
    expect(bytes(fitted.payload)).toBeLessThanOrEqual(INCLUDED_USAGE_REQUEST_BUDGET_BYTES);
    const outputs = (fitted.payload.input as Array<{ output: string }>).map((item) => item.output);
    expect(outputs[0]).toContain(TRIMMED_OUTPUT_TEXT);
    expect(outputs[0]?.startsWith("START-")).toBe(true);
    expect(outputs[0]?.endsWith("-END")).toBe(true);
    // Two outputs had to give way; the newest survived intact.
    expect(outputs[2]).toBe(big("c"));
  });

  it("trims Chat-shaped tool messages too", () => {
    const payload = {
      messages: [
        { role: "tool", tool_call_id: "a", content: "x".repeat(1200 * 1024) },
        { role: "tool", tool_call_id: "b", content: "y".repeat(1200 * 1024) },
      ],
    };
    expect(bytes(fitRequestBytes(payload).payload)).toBeLessThanOrEqual(INCLUDED_USAGE_REQUEST_BUDGET_BYTES);
  });
});

describe("captainRequestExtension", () => {
  async function host() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const onTrimmed = vi.fn();
    await captainRequestExtension({ lane: "discord_presence", cacheSalt: "0123456789ab", onTrimmed }).factory(
      {
        on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
          handlers.set(event, handler),
      } as unknown as ExtensionAPI,
    );
    const send = (provider: string, payload: unknown) =>
      handlers.get("before_provider_request")?.(
        { type: "before_provider_request", payload },
        { model: { provider } },
      );
    return { send, onTrimmed };
  }

  it("keys every metered request by lane and leaves the subscription transport alone", async () => {
    const pi = await host();
    const payload = { model: "gpt-6-luna", prompt_cache_key: "session-1", input: [] };
    expect(pi.send("openai", payload)).toMatchObject({
      prompt_cache_key: "clankie-0123456789ab-discord_presence",
    });
    expect(pi.send("clankie", payload)).toMatchObject({
      prompt_cache_key: "clankie-0123456789ab-discord_presence",
    });
    expect(pi.send("openai-codex", payload)).toBeUndefined();
  });

  it("trims only on the included-usage path, and asks for compaction when it does", async () => {
    const pi = await host();
    const heavy = {
      prompt_cache_key: "s",
      input: [
        { role: "user", content: [image(1000)] },
        { role: "user", content: [image(1000)] },
      ],
    };
    expect(bytes(pi.send("openai", heavy))).toBeGreaterThan(INCLUDED_USAGE_REQUEST_BUDGET_BYTES);
    expect(pi.onTrimmed).not.toHaveBeenCalled();
    expect(bytes(pi.send("clankie", heavy))).toBeLessThanOrEqual(INCLUDED_USAGE_REQUEST_BUDGET_BYTES);
    expect(pi.onTrimmed).toHaveBeenCalledTimes(1);
    pi.send("clankie", { prompt_cache_key: "s", input: [] });
    expect(pi.onTrimmed).toHaveBeenCalledTimes(1);
  });
});
