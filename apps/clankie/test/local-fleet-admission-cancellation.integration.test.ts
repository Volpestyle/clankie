import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { localFleetAdmissionProof } from "../src/local-fleet-proof.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { closeNativeProcessObservers, nativeProcessRequest } from "../src/native-process-transport.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

const localIt = it.skipIf(process.platform !== "darwin");
interface Journal {
  kind: string;
  pid: number;
  mode?: string;
}
async function until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error("Fixture boundary did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-admission-cancel-"));
  const helper = join(root, "helper.mjs");
  const source = await readFile(
    new URL("./helpers/local-fleet-cancellation/fixture.mjs", import.meta.url),
    "utf8",
  );
  await writeFile(helper, `#!${process.execPath}\n${source}`);
  await chmod(helper, 0o700);
  const state: {
    shell: number;
    holdControl: boolean;
    missingPane: boolean;
    controls: number;
    closedControls: number;
    proofRefusals: string[];
    privateSeat?: Parameters<typeof localFleetAdmissionProof>[0]["privateSeat"];
  } = {
    shell: 33,
    holdControl: false,
    missingPane: false,
    controls: 0,
    closedControls: 0,
    proofRefusals: [],
  };
  const controlSockets = new Set<Socket>();
  const control = createServer((socket) => {
    controlSockets.add(socket);
    socket.once("close", () => {
      state.closedControls++;
      controlSockets.delete(socket);
    });
    let bytes = "";
    socket.on("data", (chunk) => {
      bytes += chunk.toString();
      if (!bytes.includes("\n")) return;
      const request = JSON.parse(bytes);
      state.controls++;
      if (!state.holdControl)
        socket.write(
          JSON.stringify({
            id: request.id,
            ...(state.missingPane
              ? { error: { code: "pane_not_found", message: "Fixture pane missing" } }
              : { result: { process_info: { pane_id: request.params.pane_id, shell_pid: state.shell } } }),
          }) + "\n",
        );
    });
  });
  const socketPath = join(root, "control.sock");
  await new Promise<void>((resolve) => control.listen(socketPath, resolve));
  const binding = { runtime: "external" as const, socketPath, session: "default" };
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const host = createMcpHost({ settings, credentials, curated: [], logger: { info() {}, warn() {} } });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    requestTimeoutMs: 350,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const local = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => binding,
    prove: localFleetAdmissionProof({
      binding: async () => binding,
      herdrBinary: "unused",
      processHelper: helper,
      diagnostics: (event) => {
        if (event.source === "proof") state.proofRefusals.push(event.reason);
      },
      privateSeat: (...args) => state.privateSeat?.(...args) ?? Promise.resolve(false),
    }),
  });
  const listener = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: local.fetch((request) => {
      const identity = local.identity(request);
      if (!identity) throw new Error("Fixture request lost its identity");
      return worker.handleLocalFleet(request, identity);
    }),
  });
  await new Promise<void>((resolve) =>
    listener.listening ? resolve() : listener.once("listening", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const journal = async (): Promise<Journal[]> => {
    const text = await readFile(join(root, "journal.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  return {
    state,
    binding,
    helper,
    root,
    journal,
    release: () => writeFile(join(root, "release"), "release\n"),
    initialize: async (path = "/v1/fleet/mcp") => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-clankie-pane": "w1:p1",
          "x-clankie-bridge-id": randomUUID(),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "fixture", version: "1" },
          },
        }),
        signal: AbortSignal.timeout(2_000),
      });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      await writeFile(join(root, "release"), "release\n");
      await local.close();
      await worker.close();
      await host.close();
      if ("closeAllConnections" in listener) listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      for (const socket of controlSockets) socket.destroy();
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await closeNativeProcessObservers();
      await rm(root, { recursive: true, force: true });
    },
  };
}

localIt("removes expired queued admission without killing an unrelated active native proof", async () => {
  const f = await fixture();
  try {
    const held = nativeProcessRequest(f.helper, ["hold"]);
    const rows = await until(f.journal, (rows) => rows.some((row) => row.mode === "hold"));
    const pid = rows[0]!.pid;
    const result = await f.initialize();
    expect(result.status).toBe(504);
    expect(result.body.error).toBe("worker_authentication_timeout");
    expect(f.state.controls).toBe(0);
    await f.release();
    expect(JSON.parse((await held)!.stdout).pid).toBe(pid);
    const next = await nativeProcessRequest(f.helper, ["independent"]);
    expect(JSON.parse(next!.stdout).pid).toBe(pid);
    expect((await f.journal()).filter((row) => row.kind === "request").map((row) => row.mode)).toEqual([
      "hold",
      "independent",
    ]);
  } finally {
    await f.close();
  }
});

localIt("drains expired active admission before independent native work and skips later fences", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "hold-proofs"), "hold\n");
    const request = f.initialize();
    const rows = await until(f.journal, (rows) => rows.some((row) => row.mode === "proof"));
    const pid = rows[0]!.pid;
    expect((await request).status).toBe(504);
    const next = nativeProcessRequest(f.helper, ["independent"]);
    expect((await f.journal()).filter((row) => row.kind === "request")).toHaveLength(1);
    await f.release();
    expect(JSON.parse((await next)!.stdout).pid).toBe(pid);
    expect(f.state.controls).toBe(0);
    expect((await f.journal()).filter((row) => row.kind === "request").map((row) => row.mode)).toEqual([
      "proof",
      "independent",
    ]);
  } finally {
    await f.close();
  }
});

localIt("cancels queued private Codex lifetime observation under the same admission deadline", async () => {
  const f = await fixture();
  try {
    const registry = new LocalCodexSeats(
      () => f.binding,
      async (_pid, _previous, signal) => {
        const reply = await nativeProcessRequest(f.helper, ["birth"], signal);
        return reply ? "fixture-birth" : undefined;
      },
    );
    registry.register(55, "w1:p1");
    // Flush the service-owned registration receipt before HTTP admission begins.
    await nativeProcessRequest(f.helper, ["registered"]);
    f.state.shell = 99;
    let unrelated: ReturnType<typeof nativeProcessRequest> | undefined;
    f.state.privateSeat = async (chain, pane, binding, signal) => {
      unrelated = nativeProcessRequest(f.helper, ["hold"]);
      await until(f.journal, (rows) => rows.some((row) => row.mode === "hold"));
      return registry.allows(chain, pane, binding, undefined, signal);
    };
    expect((await f.initialize()).status).toBe(504);
    await f.release();
    expect(await unrelated).toBeDefined();
    await nativeProcessRequest(f.helper, ["independent"]);
    expect((await f.journal()).filter((row) => row.kind === "request").map((row) => row.mode)).toEqual([
      "birth",
      "registered",
      "proof",
      "hold",
      "independent",
    ]);
    expect(f.state.controls).toBe(1);
  } finally {
    await f.close();
  }
});

localIt("closes cancelled owned Herdr control reads before further socket censuses", async () => {
  const f = await fixture();
  try {
    f.state.holdControl = true;
    const request = f.initialize();
    await until(
      () => f.state.controls,
      (value) => value === 1,
    );
    expect((await request).status).toBe(504);
    await until(
      () => f.state.closedControls,
      (value) => value === 1,
    );
    expect((await f.journal()).filter((row) => row.mode === "proof")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

localIt(
  "keeps genuine membership refusal distinct and preserves both fresh censuses and pane reads",
  async () => {
    const f = await fixture();
    try {
      f.state.shell = 99;
      expect(await f.initialize()).toEqual({
        status: 403,
        body: { error: "local_process_membership_required" },
      });
      expect(f.state.controls).toBe(1);
      expect((await f.journal()).filter((row) => row.mode === "proof")).toHaveLength(1);
      f.state.shell = 33;
      expect((await f.initialize()).status).toBe(200);
      expect(f.state.controls).toBe(3);
      expect((await f.journal()).filter((row) => row.mode === "proof")).toHaveLength(3);
    } finally {
      await f.close();
    }
  },
);

localIt(
  "reports unavailable native observation as a retryable refusal before MCP or seat dispatch",
  async () => {
    const f = await fixture();
    try {
      // Remove only the test's owned helper: production sees a real spawn failure.
      await rm(f.helper);
      for (const path of ["/v1/fleet/mcp", "/v1/fleet/seats/w1:p1/messages"]) {
        expect(await f.initialize(path)).toEqual({
          status: 503,
          body: {
            error: "fleet_admission_unavailable",
            retryable: true,
            reason:
              "Clankie could not verify this local fleet request yet. Retry shortly; if it persists, ask the lead to inspect clankie fleet status.",
          },
        });
      }
      expect(f.state.controls).toBe(0);
      expect(await f.journal()).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

localIt("rechecks fresh native proof after census failure without admitting a real nonmember", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "fail-next-proof"), "fail\n");
    const unavailable = await f.initialize();
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ error: "fleet_admission_unavailable", retryable: true });
    expect(f.state.controls).toBe(0);
    expect(f.state.proofRefusals).toEqual(["native_initial_unavailable"]);
    expect((await f.initialize()).status).toBe(200);
    expect(f.state.controls).toBe(2);
    expect((await f.journal()).filter((row) => row.mode === "proof")).toHaveLength(3);
    f.state.shell = 99;
    expect(await f.initialize()).toEqual({
      status: 403,
      body: { error: "local_process_membership_required" },
    });
  } finally {
    await f.close();
  }
});

localIt("keeps a private seat's missing lifetime observation retryable and verifies it again", async () => {
  const f = await fixture();
  try {
    const registry = new LocalCodexSeats(
      () => f.binding,
      async (_pid, _previous, signal) => {
        const reply = await nativeProcessRequest(f.helper, ["birth"], signal);
        return reply && JSON.parse(reply.stdout).mode === "birth" ? "fixture-birth" : undefined;
      },
    );
    registry.register(55, "w1:p1");
    await nativeProcessRequest(f.helper, ["registered"]);
    f.state.shell = 99;
    f.state.privateSeat = (chain, pane, binding, signal) =>
      registry.allowsAdmission(chain, pane, binding, undefined, signal);
    await writeFile(join(f.root, "fail-next-birth"), "fail\n");
    const unavailable = await f.initialize();
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ error: "fleet_admission_unavailable", retryable: true });
    expect(f.state.proofRefusals).toEqual(["observation_failed"]);
    expect((await f.initialize()).status).toBe(200);
    expect((await f.journal()).filter((row) => row.mode === "proof")).toHaveLength(3);
    expect((await f.journal()).filter((row) => row.mode === "birth")).toHaveLength(4);
  } finally {
    await f.close();
  }
});

localIt("distinguishes malformed pane observation from Herdr's definitive missing pane", async () => {
  const f = await fixture();
  try {
    f.state.shell = 0;
    const malformed = await f.initialize();
    expect(malformed.status).toBe(503);
    expect(malformed.body).toMatchObject({ error: "fleet_admission_unavailable", retryable: true });
    f.state.missingPane = true;
    expect(await f.initialize()).toEqual({
      status: 403,
      body: { error: "local_process_membership_required" },
    });
  } finally {
    await f.close();
  }
});
