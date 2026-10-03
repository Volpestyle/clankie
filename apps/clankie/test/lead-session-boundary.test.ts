import { describe, expect, test } from "vitest";
import { createEvalResources, createEvalSettings } from "../src/captain/eval-session-boundary.ts";

describe("inert eval session resources", () => {
  test("copies trusted text and never permits resource discovery or extension", async () => {
    const files = [{ path: "/allocated/AGENTS.md", content: "controller snapshot" }];
    const loader = createEvalResources({ systemPrompt: "fixed prompt", agentsFiles: files });
    files[0]!.content = "changed";
    loader.getAgentsFiles().agentsFiles[0]!.content = "changed again";
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      { path: "/allocated/AGENTS.md", content: "controller snapshot" },
    ]);
    expect(loader.getSystemPrompt()).toBe("fixed prompt");
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
    expect(() =>
      loader.extendResources({ skillPaths: [{ path: "/candidate/evil", metadata: {} as never }] }),
    ).toThrow("disabled");
    expect(() => createEvalResources({ systemPrompt: "bad\0text", agentsFiles: [] })).toThrow("snapshot");
  });

  test("settings cannot re-enable cache warming, retries, transports or package discovery", async () => {
    const settings = createEvalSettings();
    expect(settings.getCacheWarmingMode()).toBe("off");
    expect(settings.getTransport()).toBe("sse");
    expect(settings.getBlockImages()).toBe(true);
    expect(settings.getRetrySettings().enabled).toBe(false);
    expect(settings.getProviderRetrySettings().maxRetries).toBe(0);
    const snapshot = settings.getSettings();
    snapshot.packages = ["candidate-package"];
    expect(settings.getPackages()).toEqual([]);
    expect(() => settings.setCacheWarmingMode("streaming")).toThrow("immutable");
    expect(() => settings.applyOverrides({ packages: ["candidate-package"] })).toThrow("immutable");
    expect(() => settings.setExtensionPaths(["/candidate/evil.js"])).toThrow("immutable");
    expect(() =>
      Object.defineProperty(settings, "getCacheWarmingMode", { value: () => "streaming" }),
    ).toThrow("immutable");
    await settings.reload();
    expect(settings.getCacheWarmingMode()).toBe("off");
  });
});
