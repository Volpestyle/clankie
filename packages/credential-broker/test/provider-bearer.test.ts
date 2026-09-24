import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProviderBearer } from "../src/provider-bearer.ts";
import { sharedCredentialStore } from "./fixtures/shared-credential-store.ts";

const expired = { type: "oauth" as const, access: "old", refresh: "rotating", expires: 1, clientId: "test" };
const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await stopped;
    }
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(kind: "file" | "keychain") {
  const directory = await mkdtemp(join(tmpdir(), "clankie-refresh-"));
  directories.push(directory);
  return { directory, store: sharedCredentialStore(kind, directory) };
}

// Real independent Node processes model the CLI/service boundary. The parent
// releases the fake token endpoint explicitly rather than relying on sleeps.
async function worker(kind: "file" | "keychain", directory: string, operation: "refresh" | "delete") {
  const script = join(directory, `worker-${children.length}.mjs`);
  await writeFile(
    script,
    `
    import { sharedCredentialStore } from ${JSON.stringify(new URL("./fixtures/shared-credential-store.ts", import.meta.url).href)};
    import { resolveProviderBearer } from ${JSON.stringify(new URL("../src/provider-bearer.ts", import.meta.url).href)};
    const store = sharedCredentialStore(${JSON.stringify(kind)}, ${JSON.stringify(directory)});
    globalThis.fetch = async () => {
      process.send({ event: "refresh" });
      await new Promise(resolve => process.once("message", resolve));
      return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
    };
    process.send({ event: "started" });
    try {
      const value = ${operation === "delete" ? 'await store.delete("linear")' : 'await resolveProviderBearer(" Linear/ ", store)'};
      process.send({ event: "result", value }, () => process.disconnect());
    } catch (error) {
      process.send({ event: "error", message: error.message }, () => process.disconnect());
    }
  `,
  );
  const child = fork(script, [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  let refreshCount = 0;
  let signalRefresh!: () => void;
  let signalStart!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    signalRefresh = resolve;
  });
  const started = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  const result = new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    child.on("message", (message: { event: string; value?: unknown; message?: string }) => {
      if (message.event === "started") signalStart();
      if (message.event === "refresh") {
        refreshCount++;
        signalRefresh();
      }
      if (message.event === "result") {
        settled = true;
        resolve(message.value);
      }
      if (message.event === "error") {
        settled = true;
        reject(new Error(message.message));
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`credential worker exited ${code}: ${stderr}`));
    });
  });
  // Surface early process failures even while the test waits for its handshake.
  return {
    started: Promise.race([started, result.then(() => undefined)]),
    refreshing: () =>
      Promise.race([
        refreshing,
        result.then(() => {
          throw new Error("refresh did not start");
        }),
      ]),
    result,
    release: () => child.send({ event: "release" }),
    refreshCount: () => refreshCount,
  };
}

describe.each(["file", "keychain"] as const)("%s provider refresh", (kind) => {
  it("spends a rotating token once across independent processes", async () => {
    const { directory, store } = await setup(kind);
    await store.set("linear", expired);
    const first = await worker(kind, directory, "refresh");
    await first.refreshing();
    const second = await worker(kind, directory, "refresh");
    await second.started;
    first.release();
    expect(await Promise.all([first.result, second.result])).toEqual(["new", "new"]);
    expect(first.refreshCount() + second.refreshCount()).toBe(1);
    expect(await store.get("linear")).toMatchObject({ access: "new", refresh: "rotated" });
  });

  it("does not resurrect an account after another process finishes disconnecting", async () => {
    const { directory, store } = await setup(kind);
    await store.set("linear", expired);
    const refresh = await worker(kind, directory, "refresh");
    await refresh.refreshing();
    const disconnect = await worker(kind, directory, "delete");
    await disconnect.started;
    refresh.release();
    expect(await refresh.result).toBe("new");
    expect(await disconnect.result).toBe(true);
    expect(await resolveProviderBearer("linear", sharedCredentialStore(kind, directory))).toBeUndefined();
    expect(await store.get("linear")).toBeUndefined();
  });

  it("preserves a replacement account queued during refresh", async () => {
    const { directory, store } = await setup(kind);
    await store.set("linear", expired);
    const refresh = await worker(kind, directory, "refresh");
    await refresh.refreshing();
    const replacement = sharedCredentialStore(kind, directory).set("linear", {
      type: "api",
      key: "replacement",
    });
    refresh.release();
    await refresh.result;
    await replacement;
    expect(await resolveProviderBearer("linear", store)).toBe("replacement");
  });

  it("releases a failed refresh without overwriting or returning an expired token", async () => {
    const { store } = await setup(kind);
    await store.set("linear", expired);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("token endpoint unavailable");
      }),
    );
    await expect(resolveProviderBearer("linear", store)).rejects.toThrow("token endpoint unavailable");
    expect(await store.get("linear")).toEqual(expired);
    await store.delete("linear");
    expect(await resolveProviderBearer("linear", store)).toBeUndefined();
  });

  it("keeps a still-valid token after a proactive refresh fails", async () => {
    const { store } = await setup(kind);
    await store.set("linear", { ...expired, expires: Date.now() + 30_000 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await resolveProviderBearer("linear", store)).toBe("old");
  });
});
