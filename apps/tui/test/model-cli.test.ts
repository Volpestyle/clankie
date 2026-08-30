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
