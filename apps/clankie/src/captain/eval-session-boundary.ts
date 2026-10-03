import {
  createExtensionRuntime,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CaptainModelRuntime } from "./model.ts";

/** Controller-only seam. A port is not proof of containment or account coverage. */
export interface EvalSessionBoundary {
  readonly runtime: CaptainModelRuntime;
  /** Fixed, controller-validated snapshots; implementations must not discover files. */
  resources(cwd: string): ResourceLoader;
  settings(): SettingsManager;
  /** Return contained coding tools and explicitly selected native hiring tools only. */
  tools(input: { cwd: string; systemTools: boolean; authored: readonly ToolDefinition[] }): {
    tools: string[];
    customTools: ToolDefinition[];
  };
}

/** No package manager, extension importer, project discovery, or reload side effects. */
export function createEvalResources(input: {
  systemPrompt: string;
  agentsFiles: readonly { path: string; content: string }[];
}): ResourceLoader {
  const systemPrompt = input.systemPrompt;
  const agentsFiles = input.agentsFiles.map((file) => ({ ...file }));
  for (const value of [systemPrompt, ...agentsFiles.flatMap((file) => [file.path, file.content])]) {
    if (typeof value !== "string" || value.includes("\0") || value.length > 1_048_576) {
      throw new Error("Invalid controller eval resource snapshot");
    }
  }
  const runtime = createExtensionRuntime();
  return Object.freeze({
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: agentsFiles.map((file) => ({ ...file })) }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {
      throw new Error("Eval resource extension is disabled");
    },
    reload: async () => {},
  });
}

/** In-memory settings expose copied reads only. No setter or storage fallback is callable. */
export function createEvalSettings(): SettingsManager {
  const settings = SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } } });
  settings.setCacheWarmingMode("off");
  settings.setTransport("sse");
  settings.setRetryEnabled(false);
  settings.setBlockImages(true);
  return new Proxy(settings, {
    get(target, key) {
      if (key === "reload" || key === "flush") return async () => {};
      if (key === "drainErrors") return () => [];
      if (
        typeof key !== "string" ||
        (!key.startsWith("get") && key !== "isProjectTrusted") ||
        key === "getOrCreateDeviceId"
      ) {
        throw new Error("Eval settings are immutable");
      }
      const method: unknown = Reflect.get(target, key);
      if (typeof method !== "function") throw new Error("Unknown eval settings read");
      return (...args: unknown[]) => structuredClone(Reflect.apply(method, target, args));
    },
    set() {
      throw new Error("Eval settings are immutable");
    },
    defineProperty() {
      throw new Error("Eval settings are immutable");
    },
    deleteProperty() {
      throw new Error("Eval settings are immutable");
    },
  });
}
