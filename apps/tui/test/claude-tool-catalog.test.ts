import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const pluginRoot = join(import.meta.dirname, "../../../integrations/claude-plugin");
const helper = join(pluginRoot, "worker/mods/report.mjs");
// Captured from the real native TUI, stdio MCP server and HTTP reporter.
const nativeSmoke = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/claude-tool-catalog.json"), "utf8"),
);
const report = nativeSmoke.accepted.report;

function run(path: string, args: string[], env: NodeJS.ProcessEnv, input = "") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(path, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const claudeVersion = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 5_000 }).stdout;
const supportsMods = /(?:^|\s)2\.1\.(\d+)/u.exec(claudeVersion ?? "");
test.skipIf(!supportsMods || Number(supportsMods[1]) < 287)(
  "native Claude validates the actual worker and operator catalog modules",
  async () => {
    for (const root of [pluginRoot, join(pluginRoot, "worker")]) {
      const result = await run(
        "claude",
        ["plugin", "validate", join(root, ".claude-plugin/plugin.json"), "--json"],
        process.env,
      );
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const validated = JSON.parse(result.stdout);
      expect(validated.success).toBe(true);
      const hooks = validated.contents.find((entry: { type: string }) => entry.type === "hooks");
      expect(hooks.errors).toEqual([]);
      expect(hooks.notes.join("\n")).toContain("hooks: session.start");
      expect(hooks.notes.join("\n")).toContain("command.run{command=reload-plugins}");
      for (const api of [
        "$.tool.list",
        "$.mcp.connect",
        "$.session.id",
        "$.clock.after",
        "$.process.run",
        "$.ui.status",
      ])
        expect(hooks.notes.join("\n")).toContain(api);
    }
  },
);

test("native catalog crosses the subprocess and HTTP boundary with only its pane's link", async () => {
  const state = await mkdtemp(join(tmpdir(), "clankie-native-catalog-"));
  const received: {
    url: string | undefined;
    pane: string | undefined;
    bearer: string | undefined;
    body: unknown;
  }[] = [];
  const verdict = {
    status: "mismatch",
    missing: ["native_expected_probe"],
    detail: "Claude is missing native_expected_probe.",
    remediation: "Run /reload-plugins in this pane to reload the Clankie bridge and recheck its tools.",
  };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({
      url: request.url,
      pane: request.headers["x-clankie-pane"] as string | undefined,
      bearer: request.headers.authorization,
      body: JSON.parse(body),
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(verdict));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const env = {
    ...process.env,
    CLANKIE_STATE: state,
    HERDR_PANE_ID: "w1:p2",
    HERDR_SOCKET_PATH: "/tmp/selected-herdr.sock",
  };
  try {
    await mkdir(join(state, "links"));
    const link = {
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "local",
      socket: env.HERDR_SOCKET_PATH,
      url: `http://127.0.0.1:${address.port}`,
    };
    await writeFile(join(state, "links/local.json"), JSON.stringify(link));
    await writeFile(
      join(state, "links/other.json"),
      JSON.stringify({ ...link, fleet: "other", socket: "/tmp/other-herdr.sock" }),
    );
    const result = await run(process.execPath, [helper], env, JSON.stringify(report));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(verdict);
    expect(received).toEqual([
      { url: "/v1/fleet/seats/w1%3Ap2/tool-catalog", pane: "w1:p2", bearer: undefined, body: report },
    ]);
    const invalid = await run(process.execPath, [helper], env, JSON.stringify({ ...report, tools: [null] }));
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("Invalid native Claude catalog report");
    expect(received).toHaveLength(1);
    const unlinked = await run(
      process.execPath,
      [helper],
      { ...env, HERDR_SOCKET_PATH: "/tmp/unlinked.sock" },
      JSON.stringify(report),
    );
    expect(unlinked.code).toBe(0);
    expect(JSON.parse(unlinked.stdout)).toEqual({ status: "unlinked" });
    expect(received).toHaveLength(1);
    await writeFile(
      join(state, "links/local.json"),
      JSON.stringify({ ...link, schemaVersion: 1, authentication: undefined, token: "x".repeat(32) }),
    );
    const remote = await run(
      process.execPath,
      [helper],
      env,
      JSON.stringify({
        ...report,
        bridge: "operator",
        conversationId: "scratch",
        error: "Native catalog unavailable",
      }),
    );
    expect(remote.code, remote.stderr).toBe(0);
    expect(received[1]).toMatchObject({
      bearer: `Bearer ${"x".repeat(32)}`,
      body: { bridge: "operator", conversationId: "scratch", error: "Native catalog unavailable" },
    });
    expect(received[1]!.pane).toBeUndefined();
    const rejectedRoot = await run(
      process.execPath,
      [helper],
      env,
      JSON.stringify(nativeSmoke.rejectedRoot.report),
    );
    expect(rejectedRoot.code, rejectedRoot.stderr).toBe(0);
    expect(received[2]!.body).toEqual(nativeSmoke.rejectedRoot.report);
    expect(nativeSmoke.rejectedRoot.report.tools).toEqual([]);
    expect(nativeSmoke.rejectedRoot.report.error).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(state, { recursive: true, force: true });
  }
});
