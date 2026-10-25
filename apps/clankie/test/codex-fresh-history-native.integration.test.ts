// Manual native boundary proof; no model provider, credentials or owner stores are substituted.
import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";
import { codexSocketSettled } from "../src/captain/external-codex-control.ts";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  CodexAppServerClient,
  CodexNotSentError,
  openCodexSocket,
  startCodexAppServerSeat,
  type CodexServerLauncher,
} from "../src/captain/codex-app-server.ts";

const nativeIt = it.skipIf(process.platform === "win32" || process.env.CODEX_HISTORY_NATIVE_TEST !== "1");
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

async function nativeFixture(managedNaming = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-history-")));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const socketPath = join(root, "rpc.sock");
  const child = spawn(
    process.env.CODEX_HISTORY_NATIVE_BINARY ?? "codex",
    ["app-server", "--listen", `unix://${socketPath}`],
    {
      cwd: root,
      // A credential-free, owned home. Native turn/start may fail authentication,
      // but its real RPC, durable turn and history lifecycle are exercised.
      env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: root },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + String(bytes)).slice(-8000);
  });
  child.on("error", (error) => {
    spawnError = error;
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null || spawnError) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  };
  cleanups.push(stop);
  let socket: Awaited<ReturnType<typeof openCodexSocket>>;
  for (let attempt = 0; attempt < 400; attempt++) {
    if (spawnError || child.exitCode !== null)
      throw new Error(`Native Codex unavailable: ${spawnError ?? stderr}`);
    socket = await openCodexSocket(`ws+unix://${socketPath}:/`);
    if (socket) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!socket!) throw new Error(`Native socket unavailable: ${stderr}`);
  const view = new CodexAppServerClient(socket!, () => {}, 15_000);
  cleanups.push(async () => view.close());
  await view.initialize(true);
  const account = object(await view.request("account/read", { refreshToken: false }));
  expect(account.account).toBeNull();
  // Real registration bookkeeping, deliberately without remote authority:
  // this fixture is a local Unix server, not an admitted Windows fleet.
  const registration = new RemoteCodexSeats(async () => undefined).register(
    {
      fleet: { id: "fixture", session: "default", ssh: { host: "localhost", shell: "posix" } },
      pane: "owned-history-proof",
      binding: { session: "default", socketPath },
      shell: { pid: process.pid, startTime: "fixture" },
      server: {
        pid: child.pid!,
        startTime: "fixture",
        executable: process.env.CODEX_HISTORY_NATIVE_BINARY ?? "codex",
        port: 0,
      },
    },
    () => child.exitCode === null,
  );
  const server: CodexServerLauncher = async () => ({
    ...(managedNaming ? { remoteRegistration: registration } : {}),
    endpoint: `unix://${socketPath}`,
    connect: () => openCodexSocket(`ws+unix://${socketPath}:/`),
    failure: () => spawnError,
    output: () => stderr,
    close: stop,
  });
  const createRoot = async () => {
    const thread = object(
      object(
        await view.request("thread/start", {
          cwd: root,
          ephemeral: false,
          approvalPolicy: "never",
          sandbox: "read-only",
        }),
      ).thread,
    );
    // Managed remote roots are named before the brief (VUH-2144). Naming
    // creates the native metadata row before a rollout has materialized.
    if (!managedNaming)
      await view.request("thread/name/set", { threadId: thread.id, name: "Owned history proof" });
    return thread;
  };
  const materialize = async (thread: Record<string, unknown>) => {
    const started = object(
      await view.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "Owned lineage seed.", text_elements: [] }],
      }),
    );
    await expect
      .poll(
        async () => {
          try {
            return (await readFile(String(thread.path), "utf8")).includes("Owned lineage seed.");
          } catch {
            return false;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await view.request("turn/interrupt", { threadId: thread.id, turnId: object(started.turn).id });
    await expect
      .poll(
        async () =>
          object(
            object(
              object(await view.request("thread/read", { threadId: thread.id, includeTurns: false })).thread,
            ).status,
          ).type,
        { timeout: 15_000 },
      )
      .not.toBe("active");
  };
  const start = (startView: () => Promise<void>, resumeThreadId?: string) =>
    startCodexAppServerSeat({
      cwd: root,
      server,
      startView,
      ...(resumeThreadId === undefined ? {} : { resumeThreadId }),
    });
  return {
    root,
    home,
    view,
    createRoot,
    materialize,
    start,
    connect: () => openCodexSocket(`ws+unix://${socketPath}:/`),
  };
}

nativeIt(
  "dispatches one fresh brief despite an absent rollout and hydrates its real persisted turn",
  async () => {
    const f = await nativeFixture();
    let root: Record<string, unknown> = {};
    const seat = await f.start(async () => {
      root = await f.createRoot();
    });
    cleanups.push(() => seat.close());
    expect(root.ephemeral).toBe(false);
    expect(root.forkedFromId).toBeNull();
    const materialized = await access(String(root.path)).then(
      () => true,
      () => false,
    );
    if (!materialized) {
      await expect(
        f.view.request("thread/turns/list", {
          threadId: root.id,
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
        }),
      ).rejects.toThrow(`invalid paginated history lineage for ${root.id}: missing source rollout`);
    }
    const brief = "VUH-2167 owned native history proof. Reply READY.";
    const sent = await seat.send(brief);
    expect(sent).toMatchObject({ state: "started" });
    await seat.stopTask!(async () => {});
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await f.view.request("thread/turns/list", {
              threadId: root.id,
              limit: 10,
              sortDirection: "desc",
              itemsView: "full",
            }),
          ),
        { timeout: 15_000 },
      )
      .toContain(brief);
    const history = object(
      await f.view.request("thread/turns/list", {
        threadId: root.id,
        limit: 10,
        sortDirection: "desc",
        itemsView: "full",
      }),
    );
    const turns = history.data as Record<string, unknown>[];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe(sent.turnId);
    expect(JSON.stringify(turns[0])).toContain(brief);
    expect(await readFile(String(root.path), "utf8")).toContain(brief);
    expect(sent.turnId).toBeTypeOf("string");
    // stopTask can race native turn startup. Establish a real terminal turn
    // before asking the read-only observer to recover its retained completion.
    await f.view
      .request("turn/interrupt", { threadId: root.id, turnId: sent.turnId })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes("no active turn to interrupt")) throw error;
      });
    const completion = await codexSocketSettled(
      f.connect,
      String(root.id),
      sent.turnId!,
      AbortSignal.timeout(15_000),
      async () => {},
    );
    expect(completion).toMatchObject({
      type: "turn_completed",
      messageId: sent.turnId,
      nativeTurnId: sent.turnId,
    });
    if (completion.type !== "turn_completed") throw new Error("Native completion unavailable");
    expect(["completed", "interrupted", "failed"]).toContain(completion.stopReason);
  },
  60_000,
);

nativeIt(
  "refuses the same absent rollout when the caller resumes a saved identity",
  async () => {
    const f = await nativeFixture();
    const root = await f.createRoot();
    const materialized = await access(String(root.path)).then(
      () => true,
      () => false,
    );
    if (materialized) {
      // Newer native versions materialize during startup. Break an actual
      // persisted saved root, rather than asserting the older lazy lifecycle.
      await f.materialize(root);
      await f.view.request("thread/archive", { threadId: root.id });
      await f.view.request("thread/unarchive", { threadId: root.id });
      const archived = object(
        object(await f.view.request("thread/read", { threadId: root.id, includeTurns: false })).thread,
      );
      root.path = archived.path;
      await rm(String(root.path));
    }
    await expect(
      f.start(async () => {
        if (materialized) await f.view.request("thread/resume", { threadId: root.id, excludeTurns: true });
      }, String(root.id)),
    ).rejects.toThrow(/missing source rollout|no rollout found/u);
    await expect(access(String(root.path))).rejects.toMatchObject({ code: "ENOENT" });
  },
  60_000,
);

nativeIt(
  "refuses a native fork whose persisted ancestor was removed",
  async () => {
    const f = await nativeFixture();
    let fork: Record<string, unknown> = {};
    let source: Record<string, unknown> = {};
    const seat = await f.start(async () => {
      source = await f.createRoot();
      // Native persistence, then a real native fork; only this fixture's file is removed.
      await f.materialize(source);
      fork = object(
        object(await f.view.request("thread/fork", { threadId: source.id, excludeTurns: true })).thread,
      );
      await f.view.request("thread/archive", { threadId: source.id });
      const archived = object(
        object(await f.view.request("thread/read", { threadId: source.id, includeTurns: false })).thread,
      );
      source.path = archived.path;
      await expect
        .poll(async () => object(await f.view.request("thread/loaded/list", {})).data)
        .toEqual([fork.id]);
      await rm(String(source.path));
    });
    cleanups.push(() => seat.close());
    expect(fork.forkedFromId).toBe(source.id);
    await expect(seat.send("Never dispatch this broken fork brief.")).rejects.toBeInstanceOf(
      CodexNotSentError,
    );
    await expect(readFile(String(fork.path), "utf8")).resolves.not.toContain("Never dispatch");
  },
  60_000,
);

nativeIt(
  "refuses corrupt persisted history on a newly created native root",
  async () => {
    const f = await nativeFixture();
    let root: Record<string, unknown> = {};
    await expect(
      f.start(async () => {
        root = await f.createRoot();
        await f.materialize(root);
        await writeFile(String(root.path), "corrupt native fixture rollout\n");
      }),
    ).rejects.toThrow(/failed to read thread.*session metadata/u);
    expect(await readFile(String(root.path), "utf8")).not.toContain("Never dispatch");
  },
  60_000,
);

nativeIt(
  "dispatches once after managed naming replaces a fresh root's synthesized creation time",
  async () => {
    const f = await nativeFixture(true);
    let root: Record<string, unknown> = {};
    let before: Record<string, unknown> = {};
    const seat = await f.start(async () => {
      root = await f.createRoot();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      before = object(
        object(await f.view.request("thread/read", { threadId: root.id, includeTurns: false })).thread,
      );
    });
    cleanups.push(() => seat.close());
    const named = object(
      object(await f.view.request("thread/read", { threadId: root.id, includeTurns: false })).thread,
    );
    expect(named.name).toBe("Clankie worker");
    // 0.160.1 synthesizes read time until name/set persists actual creation.
    if (root.cliVersion === "0.160.1") {
      expect(named.createdAt).toBe(root.createdAt);
      expect(named.createdAt).not.toBe(before.createdAt);
    }
    console.info("managed naming metadata", {
      version: root.cliVersion,
      original: root.createdAt,
      beforeNaming: before.createdAt,
      afterNaming: named.createdAt,
    });
    const brief = "VUH-2167 managed naming regression. Reply READY.";
    const sent = await seat.send(brief);
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await f.view.request("thread/turns/list", {
              threadId: root.id,
              limit: 10,
              sortDirection: "desc",
              itemsView: "full",
            }),
          ),
        { timeout: 15_000 },
      )
      .toContain(brief);
    await seat.stopTask!(async () => {});
    const history = object(
      await f.view.request("thread/turns/list", {
        threadId: root.id,
        limit: 10,
        sortDirection: "desc",
        itemsView: "full",
      }),
    );
    const turns = history.data as Record<string, unknown>[];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.id).toBe(sent.turnId);
    expect(JSON.stringify(turns[0])).toContain(brief);
    expect(await readFile(String(named.path), "utf8")).toContain(brief);
  },
  60_000,
);
