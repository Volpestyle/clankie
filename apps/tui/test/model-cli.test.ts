import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isHeadlessCaptainCommand, runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { loadConfig } from "@clankie/model-provider";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    text: () => output,
  };
}

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-model-cli-"));
  tempDirs.push(root);
  return {
    XDG_CONFIG_HOME: root,
    XDG_STATE_HOME: root,
    XDG_CACHE_HOME: join(root, "cache"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
  };
}

async function runModel(
  args: readonly string[],
  overrides: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<{ exit: number; stdout: string; stderr: string; env: NodeJS.ProcessEnv }> {
  const env = overrides.env ?? (await isolatedEnv());
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const exit = await runHeadlessCaptainCommand(["model", ...args], {
    repoRoot: "/unused",
    env,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
  });
  return { exit, stdout: stdout.text(), stderr: stderr.text(), env };
}

describe("clankie model — recognition", () => {
  it("is a headless command", () => {
    expect(isHeadlessCaptainCommand("model")).toBe(true);
  });
});

describe("clankie model add-local / set / status", () => {
  it("probes the endpoint, writes the provider, and can select it as captain", async () => {
    const env = await isolatedEnv();
    const listed = await runModel(
      ["add-local", "--id", "ds4", "--base-url", "http://127.0.0.1:8000", "--set"],
      {
        env,
        fetchImpl: async (input) => {
          expect(String(input)).toBe("http://127.0.0.1:8000/v1/models");
          return Response.json({ data: [{ id: "deepseek-v4-flash" }] });
        },
      },
    );
    expect(listed.exit).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      ok: true,
      providerId: "ds4",
      baseURL: "http://127.0.0.1:8000/v1",
      models: ["deepseek-v4-flash"],
      model: "ds4/deepseek-v4-flash",
      restart: "clankie restart captain",
    });
    expect((await loadConfig({ env })).config.model).toBe("ds4/deepseek-v4-flash");

    const switched = await runModel(["set", "xai/grok-4.6"], { env });
    expect(switched.exit).toBe(0);
    expect(JSON.parse(switched.stdout)).toMatchObject({ ok: true, model: "xai/grok-4.6" });

    const status = await runModel(["status"], { env });
    expect(JSON.parse(status.stdout)).toMatchObject({
      ok: true,
      model: "xai/grok-4.6",
      providers: { ds4: { baseURL: "http://127.0.0.1:8000/v1", models: ["deepseek-v4-flash"] } },
    });
  });

  it("falls back to --models when the endpoint is unreachable", async () => {
    const listed = await runModel(
      ["add-local", "--id", "ds4", "--base-url", "http://127.0.0.1:8000/v1", "--models", "deepseek-v4-flash"],
      { fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) },
    );
    expect(listed.exit).toBe(0);
    const body = JSON.parse(listed.stdout) as {
      ok: boolean;
      models: string[];
      probeError: string;
      model: null;
    };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(["deepseek-v4-flash"]);
    expect(body.probeError).toContain("ECONNREFUSED");
    expect(body.model).toBeNull();
  });

  it("fails closed when the endpoint is down and no --models were given", async () => {
    const listed = await runModel(["add-local", "--id", "ds4", "--base-url", "http://127.0.0.1:8000/v1"], {
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(listed.exit).toBe(1);
    expect(JSON.parse(listed.stdout)).toMatchObject({ ok: false });
  });
});

describe("clankie model refresh", () => {
  /**
   * The catalog is otherwise whatever the install shipped with, so a model
   * released after that version is unselectable until something fetches. This
   * is the headless half of the TUI's "refresh model catalogs".
   */
  it("fetches models.dev, rewrites the cache, and reports what a later resolve will read", async () => {
    const env = await isolatedEnv();
    const catalog = {
      openai: {
        id: "openai",
        name: "OpenAI",
        env: ["OPENAI_API_KEY"],
        models: { "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: true } },
      },
    };
    const before = await runModel(["status"], { env });
    expect(before.exit).toBe(0);

    const refreshed = await runModel(["refresh"], {
      env,
      fetchImpl: (() => Promise.resolve(Response.json(catalog))) as unknown as typeof fetch,
    });
    expect(refreshed.exit).toBe(0);
    expect(JSON.parse(refreshed.stdout)).toMatchObject({
      ok: true,
      source: "network",
      updated: true,
      providers: 1,
      models: 1,
      restart: "clankie restart captain",
    });
  });

  it("reports the fallback source rather than failing when the network is down", async () => {
    const env = await isolatedEnv();
    const result = await runModel(["refresh"], {
      env,
      fetchImpl: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
    });
    // Exit 1 with an honest source beats a green run over a catalog that never moved.
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, source: "bundled", updated: false });
  });

  it("rejects extra arguments", async () => {
    const result = await runModel(["refresh", "openai"]);
    expect(result.exit).not.toBe(0);
  });
});
