import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import type { HttpBindings } from "@hono/node-server";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFleetShellRun,
  createFleetShellStream,
  createHerdrFleetRun,
  powershellScriptCommand,
  remoteProgramCommand,
  type HerdrFleet,
} from "../src/herdr-fleet.ts";
import { FleetLinks } from "../src/fleet-link.ts";

const fleet: HerdrFleet = {
  id: "fixture-pc",
  session: "default",
  ssh: { host: "fixture.invalid", shell: "powershell" },
};
const roots: string[] = [];
const linksToClose: FleetLinks[] = [];
const serversToClose: Server[] = [];
afterEach(async () => {
  for (const links of linksToClose.splice(0)) links.close();
  await Promise.all(
    serversToClose.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

interface SshCall {
  kind: "forward" | "command";
  controlPath?: string;
  capturedPath?: string;
  fresh?: boolean;
}
interface RelayCall {
  kind:
    | "relay-ready"
    | "execute-start"
    | "execute-result"
    | "relay-exit"
    | "response-paused"
    | "response-resumed"
    | "stream-ack"
    | "drain-ack";
  pid: number;
  port?: number;
  time: number;
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-fleet-ssh-")));
  roots.push(root);
  const bin = join(root, "bin");
  const oldBin = join(root, "old-bin");
  const newBin = join(root, "new-bin");
  await Promise.all([bin, oldBin, newBin].map((path) => mkdir(path)));
  const executable = async (directory: string, name: string, source: string) => {
    await writeFile(
      join(directory, name),
      `#!${process.execPath}\nimport ${JSON.stringify(new URL(`./fixtures/fleet-ssh-recovery/${source}`, import.meta.url).href)};\n`,
      { mode: 0o700 },
    );
  };
  await executable(bin, "ssh", "ssh.mjs");
  await executable(oldBin, "fixtureprobe", "program.mjs");
  const login = (
    path: string,
    mode = "success",
    options: { proofDelayMs?: number; responseDelayMs?: number } = {},
  ) => writeFile(join(root, "login.json"), JSON.stringify({ path, mode, ...options }));
  await login(oldBin);
  // No real ssh is reachable even if the production runner selects its default.
  vi.stubEnv("PATH", bin);
  vi.stubEnv("CLANKIE_FLEET_SSH_FIXTURE", root);
  const lines = async <T>(name: string): Promise<T[]> => {
    try {
      return (await readFile(join(root, `${name}.jsonl`), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const controlDirectory = join(root, "controls");
  return {
    root,
    oldBin,
    newBin,
    controlDirectory,
    login,
    install: (directory: string, name = "herdr") => executable(directory, name, "program.mjs"),
    ssh: () => lines<SshCall>("ssh"),
    powershell: () => lines<{ quiet: boolean }>("powershell"),
    programs: () => lines<{ args: string[]; cwd: string }>("program"),
    relays: () => lines<RelayCall>("relay"),
    stopRelay: (pid: number) => writeFile(join(root, `stop-relay-${pid}`), "stop fixture relay"),
  };
}

it("reopens one captured SSH environment after a remote PATH change and reaches Herdr", async () => {
  const f = await fixture();
  const shell = createFleetShellRun(fleet, { controlDirectory: f.controlDirectory });
  await shell(remoteProgramCommand("powershell", "fixtureprobe", ["environment"]));
  await f.install(f.newBin);
  await f.login(`${f.newBin}${delimiter}${f.oldBin}`);
  const run = createHerdrFleetRun(fleet, { controlDirectory: f.controlDirectory });
  await expect(run(["api", "snapshot"])).resolves.toContain('"accepted":true');
  const commands = (await f.ssh()).filter((call) => call.kind === "command");
  expect(commands).toHaveLength(3); // warm master, stale failure, one fresh retry
  expect(commands[0]!.controlPath).toBe(commands[1]!.controlPath);
  expect(commands[2]!.controlPath).not.toBe(commands[1]!.controlPath);
  expect(commands[2]!.capturedPath).toBe(`${f.newBin}${delimiter}${f.oldBin}`);
  expect((await f.programs()).filter((call) => call.args.includes("snapshot"))).toHaveLength(1);
  expect((await f.powershell()).every((call) => call.quiet)).toBe(true);
});

it("keeps the decoded remote failure in link status and logs after exactly one recovery", async () => {
  const f = await fixture();
  await f.login(f.oldBin, "missing-clixml");
  const log: string[] = [];
  const links = new FleetLinks({
    shell: () => createFleetShellRun(fleet, { controlDirectory: f.controlDirectory }),
    log: (message) => log.push(message),
  });
  linksToClose.push(links);
  links.start([fleet], 4567);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "unreachable" }));
  expect(links.status(fleet.id)).toMatchObject({
    error: expect.stringContaining("The term 'herdr' is not recognized"),
  });
  expect(log.join("\n")).toContain("The term 'herdr' is not recognized");
  expect(JSON.stringify(links.status(fleet.id)) + log.join("\n")).not.toMatch(
    /CLIXML|<Objs|Preparing modules|clankie-launch-/u,
  );
  const commands = (await f.ssh()).filter((call) => call.kind === "command");
  expect(commands).toHaveLength(2);
  expect(new Set(commands.map((call) => call.controlPath)).size).toBe(2);
});

it("refreshes an old command master even when commands continue succeeding", async () => {
  const f = await fixture();
  await f.install(f.newBin, "fixtureprobe");
  const run = createFleetShellRun(fleet, { controlDirectory: f.controlDirectory, maxControlAgeMs: 1_000 });
  const command = remoteProgramCommand("powershell", "fixtureprobe", ["environment"]);
  await expect(run(command)).resolves.toContain('"environment":"old-bin"');
  await f.login(`${f.newBin}${delimiter}${f.oldBin}`);
  await expect(run(command)).resolves.toContain('"environment":"old-bin"');
  await delay(1_100);
  await expect(run(command)).resolves.toContain('"environment":"new-bin"');
  const commands = (await f.ssh()).filter((call) => call.kind === "command");
  expect(commands).toHaveLength(3);
  expect(commands[0]!.controlPath).toBe(commands[1]!.controlPath);
  expect(commands[2]!.controlPath).not.toBe(commands[1]!.controlPath);
});

it("drains a failed relay's large progress stream before decoding its final error", async () => {
  const f = await fixture();
  const log: string[] = [];
  const links = new FleetLinks({
    shell: () => createFleetShellRun(fleet, { controlDirectory: f.controlDirectory }),
    stream: () => createFleetShellStream(fleet, { controlDirectory: f.controlDirectory }),
    log: (message) => log.push(message),
  });
  linksToClose.push(links);
  links.start([fleet], 4567);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "unreachable" }));
  expect(links.status(fleet.id)).toMatchObject({
    error: expect.stringContaining("The term 'relay dependency' is not recognized"),
  });
  expect(log.join("\n")).toContain("The term 'relay dependency' is not recognized");
  expect(JSON.stringify(links.status(fleet.id)) + log.join("\n")).not.toMatch(
    /CLIXML|<Objs|Preparing modules/u,
  );
});

it("retries a process-start environment failure once before exposing its real reason", async () => {
  const f = await fixture();
  const shell = createFleetShellRun(fleet, { controlDirectory: f.controlDirectory });
  await expect(
    shell(remoteProgramCommand("powershell", "fixtureprobe", [], join(f.root, "missing directory"))),
  ).rejects.toThrow("ENOENT");
  const commands = (await f.ssh()).filter((call) => call.kind === "command");
  expect(commands).toHaveLength(2);
  expect(commands[0]!.controlPath).not.toBe(commands[1]!.controlPath);
  expect(await f.programs()).toHaveLength(0);
});

it("recovers the POSIX PATH and preserves quoted argv and cwd through a real shell", async () => {
  const f = await fixture();
  const posixFleet: HerdrFleet = { ...fleet, ssh: { ...fleet.ssh, shell: "posix" } };
  const shell = createFleetShellRun(posixFleet, { controlDirectory: f.controlDirectory });
  await shell(remoteProgramCommand("posix", "fixtureprobe", ["environment"]));
  await f.install(f.newBin);
  await f.login(`${f.newBin}${delimiter}${f.oldBin}`);
  const run = createHerdrFleetRun(posixFleet, { controlDirectory: f.controlDirectory });
  const payload = `it's $HOME; printf hijacked > ${join(f.root, "argument-must-stay-text")}`;
  await expect(run(["pane", "send-text", "w2:p1", payload])).resolves.toContain('"accepted":true');
  expect((await f.programs()).at(-1)?.args).toEqual([
    "--session",
    "default",
    "pane",
    "send-text",
    "w2:p1",
    payload,
  ]);
  await expect(access(join(f.root, "argument-must-stay-text"))).rejects.toMatchObject({ code: "ENOENT" });
  const commands = (await f.ssh()).filter((call) => call.kind === "command");
  expect(commands).toHaveLength(3);
  expect(commands[0]!.controlPath).toBe(commands[1]!.controlPath);
  expect(commands[2]!.controlPath).not.toBe(commands[1]!.controlPath);

  const cwd = join(f.root, "working ' directory");
  await mkdir(cwd);
  await shell(remoteProgramCommand("posix", "fixtureprobe", ["environment"], cwd));
  expect((await f.programs()).at(-1)?.cwd).toBe(cwd);
});

it.each(["herdr-business-error", "native-business-error", "native-business-launcher-error"])(
  "does not replay a mutation rejected by an already launched program (%s)",
  async (mode) => {
    const f = await fixture();
    await f.install(f.oldBin);
    await f.login(f.oldBin, mode);
    const pending =
      mode === "herdr-business-error"
        ? createHerdrFleetRun(fleet, { controlDirectory: f.controlDirectory })(["agent", "start"])
        : createFleetShellRun(fleet, { controlDirectory: f.controlDirectory })(
            remoteProgramCommand("powershell", "fixtureprobe", ["mutate"]),
          );
    const message =
      mode === "herdr-business-error"
        ? "server_not_running"
        : mode === "native-business-error"
          ? "Application rejected the mutation"
          : "The term 'dependency' is not recognized";
    await expect(pending).rejects.toThrow(message);
    expect((await f.ssh()).filter((call) => call.kind === "command")).toHaveLength(1);
    expect(await f.programs()).toHaveLength(1);
  },
);

it("replaces a ready relay without interrupting its in-flight proof or authenticated HTTP response", async () => {
  const f = await fixture();
  await f.install(f.oldBin);
  await f.login(f.oldBin, "relay-success", { proofDelayMs: 1_800, responseDelayMs: 300 });
  const responseBody = "held-http-response:".padEnd(256 * 1024, "proof-body-");
  const responseHash = createHash("sha256").update(responseBody).digest("hex");
  const log: string[] = [];
  const links = new FleetLinks({
    shell: () => createFleetShellRun(fleet, { controlDirectory: f.controlDirectory }),
    stream: () => createFleetShellStream(fleet, { controlDirectory: f.controlDirectory }),
    maxAgeMs: 1_200,
    log: (message) => log.push(message),
  });
  linksToClose.push(links);
  let releaseReply!: () => void;
  const heldReply = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let admitted: ReturnType<FleetLinks["identity"]>;
  const linkedFetch = links.fetch(async (request) => {
    admitted = links.identity(request);
    await heldReply;
    return new Response(responseBody);
  });
  const service = createServer((incoming, outgoing) => {
    const pane = incoming.headers["x-clankie-pane"];
    const request = new Request(`http://fixture${incoming.url}`, {
      headers: { "x-clankie-pane": typeof pane === "string" ? pane : "" },
    });
    void Promise.resolve(linkedFetch(request, { incoming } as HttpBindings))
      .then(async (response) => {
        outgoing.statusCode = response.status;
        outgoing.end(await response.text());
      })
      .catch((error: unknown) => {
        outgoing.statusCode = 500;
        outgoing.end(String(error));
      });
  });
  serversToClose.push(service);
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  const serviceAddress = service.address();
  if (!serviceAddress || typeof serviceAddress === "string") throw new Error("Fixture HTTP listener missing");
  links.start([fleet], serviceAddress.port);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "ready" }), {
    timeout: 4_000,
  });
  const oldReady = (await f.relays()).find((call) => call.kind === "relay-ready")!;
  const lifetime = links.lifetime(fleet);
  const reply = fetch(`http://127.0.0.1:${oldReady.port}/v1/fleet/mcp`, {
    headers: { "x-clankie-pane": "w8:p1", connection: "close" },
    signal: AbortSignal.timeout(5_000),
  })
    .then(async (response) => {
      const body = await response.text();
      return {
        status: response.status,
        bytes: body.length,
        hash: createHash("sha256").update(body).digest("hex"),
      };
    })
    .catch((error: unknown) => ({ error }));
  await vi.waitFor(() => expect(admitted?.fleet).toBe(fleet.id));
  const observer = links.observer(fleet)!;
  const pending = observer(powershellScriptCommand("Write-Output 'proof-complete'"), 5_000).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.waitFor(async () =>
    expect((await f.relays()).some((call) => call.kind === "execute-start")).toBe(true),
  );
  const states: (string | undefined)[] = [];
  const sampling = setInterval(() => states.push(links.status(fleet.id)?.state), 5);
  try {
    await vi.waitFor(
      () => {
        const status = links.status(fleet.id);
        expect(status?.state).toBe("ready");
        expect(status?.state === "ready" && status.port !== oldReady.port).toBe(true);
      },
      { timeout: 3_000 },
    );
    expect((await f.relays()).some((call) => call.kind === "relay-exit" && call.pid === oldReady.pid)).toBe(
      false,
    );
    await vi.waitFor(async () =>
      expect((await f.relays()).some((call) => call.kind === "drain-ack" && call.pid === oldReady.pid)).toBe(
        true,
      ),
    );
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: oldReady.port! });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(lifetime()).toBe(true);
    expect(await pending).toEqual({ value: "proof-complete" });
    expect(await admitted!.validate()).toBe(true);
    expect((await f.relays()).some((call) => call.kind === "relay-exit" && call.pid === oldReady.pid)).toBe(
      false,
    );
    releaseReply();
    expect(await reply).toEqual({ status: 200, bytes: responseBody.length, hash: responseHash });
    await vi.waitFor(async () =>
      expect((await f.relays()).some((call) => call.kind === "relay-exit" && call.pid === oldReady.pid)).toBe(
        true,
      ),
    );
    const calls = await f.relays();
    const ready = calls.filter((call) => call.kind === "relay-ready");
    const oldExit = calls.find((call) => call.kind === "relay-exit" && call.pid === oldReady.pid)!;
    const oldResult = calls.find((call) => call.kind === "execute-result" && call.pid === oldReady.pid)!;
    const resumed = calls.find((call) => call.kind === "response-resumed" && call.pid === oldReady.pid)!;
    const acknowledged = calls.find((call) => call.kind === "stream-ack" && call.pid === oldReady.pid)!;
    expect(ready).toHaveLength(2);
    expect(ready[1]!.time).toBeLessThanOrEqual(oldExit.time);
    expect(oldResult.time).toBeLessThanOrEqual(oldExit.time);
    expect(resumed.time).toBeLessThanOrEqual(oldExit.time);
    expect(acknowledged.time).toBeLessThanOrEqual(oldExit.time);
    expect(states.every((state) => state === "ready")).toBe(true);
    expect(log.join("\n")).not.toContain("link down");
  } finally {
    clearInterval(sampling);
    releaseReply();
  }
});

it("keeps the working link through a failed renewal, then recovers a real promoted-relay outage", async () => {
  const f = await fixture();
  await f.install(f.oldBin);
  await f.login(f.oldBin, "relay-success");
  const log: string[] = [];
  const links = new FleetLinks({
    shell: () => createFleetShellRun(fleet, { controlDirectory: f.controlDirectory }),
    stream: () => createFleetShellStream(fleet, { controlDirectory: f.controlDirectory }),
    maxAgeMs: 1_000,
    log: (message) => log.push(message),
  });
  linksToClose.push(links);
  links.start([fleet], 4567);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "ready" }), {
    timeout: 4_000,
  });
  const initial = (await f.relays()).find((call) => call.kind === "relay-ready")!;
  const lifetime = links.lifetime(fleet);
  await f.login(f.oldBin, "relay-failure");
  await vi.waitFor(
    () => expect(log.some((message) => message.includes("link refresh pending:"))).toBe(true),
    { timeout: 3_000 },
  );
  expect(links.status(fleet.id)).toMatchObject({ state: "ready", port: initial.port });
  expect(lifetime()).toBe(true);
  await expect(
    links.observer(fleet)!(powershellScriptCommand("Write-Output 'proof-complete'")),
  ).resolves.toBe("proof-complete");
  expect(log.join("\n")).not.toContain("link down");

  await f.login(f.oldBin, "relay-success");
  await vi.waitFor(
    () => {
      const status = links.status(fleet.id);
      expect(status?.state === "ready" && status.port !== initial.port).toBe(true);
    },
    { timeout: 5_000 },
  );
  expect(lifetime()).toBe(true);
  expect(log.join("\n")).not.toContain("link down");
  const promoted = (await f.relays()).filter((call) => call.kind === "relay-ready").at(-1)!;
  await f.stopRelay(promoted.pid);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "unreachable" }));
  expect(lifetime()).toBe(false);
  await vi.waitFor(
    () => {
      const status = links.status(fleet.id);
      expect(status?.state === "ready" && status.port !== promoted.port).toBe(true);
    },
    { timeout: 5_000 },
  );
  expect(lifetime()).toBe(false);
  expect(links.lifetime(fleet)()).toBe(true);
  await expect(
    links.observer(fleet)!(powershellScriptCommand("Write-Output 'proof-complete'")),
  ).resolves.toBe("proof-complete");
});
