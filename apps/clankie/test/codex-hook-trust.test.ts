import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { trustInstalledCodexWorkerHooks } from "../src/captain/codex-hook-trust.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-hook-trust-")));
  roots.push(root);
  const home = join(root, "worker-codex", "seat-test");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const config = join(home, "config.toml");
  await writeFile(config, "model = 'owner-model'\n", { mode: 0o600 });
  const cwd = root;
  const hooks = [
    {
      key: "clankie-worker@clankie-fleet:hooks/codex-hooks.json:session_start:0:0",
      currentHash: `sha256:${"a".repeat(64)}`,
      source: "plugin",
      enabled: true,
      trustStatus: "modified",
    },
    {
      key: "clankie-worker@clankie-fleet:hooks/codex-hooks.json:user_prompt_submit:0:0",
      currentHash: `sha256:${"b".repeat(64)}`,
      source: "plugin",
      enabled: true,
      trustStatus: "untrusted",
    },
    {
      key: "clankie-worker@clankie-fleet:hooks/codex-hooks.json:stop:0:0",
      currentHash: `sha256:${"c".repeat(64)}`,
      source: "plugin",
      enabled: true,
      trustStatus: "untrusted",
    },
    {
      key: "ponytail@ponytail:hooks.json:session_start:0:0",
      currentHash: `sha256:${"d".repeat(64)}`,
      source: "plugin",
      enabled: true,
      trustStatus: "modified",
    },
    {
      key: `${home}/hooks.json:session_start:0:0`,
      currentHash: `sha256:${"e".repeat(64)}`,
      source: "user",
      enabled: true,
      trustStatus: "trusted",
    },
    {
      key: "clankie-worker@clankie-fleet:hooks/codex-hooks.json:stop_failure:0:0",
      currentHash: `sha256:${"f".repeat(64)}`,
      source: "plugin",
      enabled: false,
      trustStatus: "untrusted",
    },
  ];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    requests.push({ method, params });
    if (method === "hooks/list") return { data: [{ cwd, hooks: structuredClone(hooks), errors: [] }] };
    if (method === "config/batchWrite") {
      expect(params.filePath).toBe(config);
      const edits = params.edits as {
        keyPath: string;
        mergeStrategy: string;
        value: Record<string, { trusted_hash: string }>;
      }[];
      expect(edits[0]).toMatchObject({ keyPath: "hooks.state", mergeStrategy: "upsert" });
      for (const [key, state] of Object.entries(edits[0]!.value)) {
        const hook = hooks.find((hook) => hook.key === key)!;
        if (state.trusted_hash === hook.currentHash) hook.trustStatus = "trusted";
      }
      return {};
    }
    throw new Error(`Unexpected RPC ${method}`);
  };
  return { root, home, cwd, hooks, requests, request };
}

it("trusts changed installed worker definitions using native hashes, without trusting other hooks", async () => {
  const f = await fixture();
  await trustInstalledCodexWorkerHooks(f);
  const write = f.requests.find((request) => request.method === "config/batchWrite")!;
  expect(write.params).toMatchObject({ filePath: join(f.home, "config.toml"), reloadUserConfig: true });
  expect((write.params.edits as { value: unknown }[])[0]?.value).toEqual(
    Object.fromEntries(f.hooks.slice(0, 3).map((hook) => [hook.key, { trusted_hash: hook.currentHash }])),
  );
  expect(f.hooks[3]?.trustStatus).toBe("modified");
  expect(f.hooks[4]?.trustStatus).toBe("trusted");
  expect(f.hooks[5]?.trustStatus).toBe("untrusted");
  expect(await readFile(join(f.home, "config.toml"), "utf8")).toBe("model = 'owner-model'\n");
  // A later deployed plugin hash gets its own native review/write, never a stale hardcoded hash.
  f.hooks[0]!.currentHash = `sha256:${"1".repeat(64)}`;
  f.hooks[0]!.trustStatus = "modified";
  await trustInstalledCodexWorkerHooks(f);
  expect(f.requests.filter((request) => request.method === "config/batchWrite")).toHaveLength(2);
  expect(f.hooks[0]?.trustStatus).toBe("trusted");
  await trustInstalledCodexWorkerHooks(f);
  expect(f.requests.filter((request) => request.method === "config/batchWrite")).toHaveLength(2);
});

it("rejects owner homes before any native write", async () => {
  const f = await fixture();
  await expect(trustInstalledCodexWorkerHooks({ ...f, home: f.root })).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it("rejects missing native discovery and never invents hashes", async () => {
  const f = await fixture();
  await expect(
    trustInstalledCodexWorkerHooks({
      ...f,
      request: async () => ({ data: [{ cwd: f.cwd, hooks: [], errors: ["failed"] }] }),
    }),
  ).rejects.toThrow("discovery unavailable");
  f.hooks[0]!.currentHash = "sha256:stale-guessed-hash";
  await expect(trustInstalledCodexWorkerHooks(f)).rejects.toThrow("hash unavailable");
  expect(f.requests.some((request) => request.method === "config/batchWrite")).toBe(false);
});
