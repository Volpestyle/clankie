import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
afterEach(async () => {
  for (const links of linksToClose.splice(0)) links.close();
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
  kind: "relay-ready" | "execute-start" | "execute-result" | "relay-exit" | "stream-ack";
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
  const login = (path: string, mode = "success") =>
    writeFile(join(root, "login.json"), JSON.stringify({ path, mode }));
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
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "unreachable" }), {
    timeout: 5_000,
  });
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
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "unreachable" }), {
    timeout: 5_000,
  });
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

it("keeps one resident relay until a real outage, then recovers on a fresh port", async () => {
  const f = await fixture();
  await f.install(f.oldBin);
  await f.login(f.oldBin, "relay-success");
  const log: string[] = [];
  const links = new FleetLinks({
    shell: () => createFleetShellRun(fleet, { controlDirectory: f.controlDirectory }),
    stream: () => createFleetShellStream(fleet, { controlDirectory: f.controlDirectory }),
    log: (message) => log.push(message),
  });
  linksToClose.push(links);
  links.start([fleet], 4567);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "ready" }), {
    timeout: 4_000,
  });
  const initial = (await f.relays()).find((call) => call.kind === "relay-ready")!;
  const lifetime = links.lifetime(fleet);
  await expect(
    links.observer(fleet)!(powershellScriptCommand("Write-Output 'proof-complete'")),
  ).resolves.toBe("proof-complete");
  expect((await f.relays()).filter((call) => call.kind === "relay-ready")).toHaveLength(1);

  await f.stopRelay(initial.pid);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "unreachable" }));
  expect(lifetime()).toBe(false);
  expect(log.join("\n")).toContain("link down");
  await vi.waitFor(
    () => {
      const status = links.status(fleet.id);
      expect(status?.state === "ready" && status.port !== initial.port).toBe(true);
    },
    { timeout: 5_000 },
  );
  expect(lifetime()).toBe(false);
  expect(links.lifetime(fleet)()).toBe(true);
  await expect(
    links.observer(fleet)!(powershellScriptCommand("Write-Output 'proof-complete'")),
  ).resolves.toBe("proof-complete");
});

it("fresh census commands reuse the resident relay and never replay a failed observation over SSH", async () => {
  const f = await fixture();
  await f.install(f.oldBin);
  await f.login(f.oldBin, "relay-success");
  const links = new FleetLinks({
    shell: () => createFleetShellRun(fleet, { controlDirectory: f.controlDirectory }),
    stream: () => createFleetShellStream(fleet, { controlDirectory: f.controlDirectory }),
  });
  linksToClose.push(links);
  links.start([fleet], 4567);
  await vi.waitFor(() => expect(links.status(fleet.id)).toMatchObject({ state: "ready" }), { timeout: 4000 });
  const relay = links.observer(fleet)!;
  const before = (await f.ssh()).filter((call) => call.kind === "command").length;
  const run = createHerdrFleetRun(fleet, { controlDirectory: f.controlDirectory, observer: () => relay });
  await expect(run(["api", "snapshot"])).resolves.toBe("proof-complete");
  await expect(run(["agent", "list"])).resolves.toBe("proof-complete");
  expect((await f.ssh()).filter((call) => call.kind === "command")).toHaveLength(before);
  expect((await f.relays()).filter((call) => call.kind === "execute-result")).toHaveLength(2);
  // Extra argv and writes continue through the command transport.
  await expect(run(["pane", "get", "w8:p1"])).resolves.toContain('"accepted":true');
  const after = (await f.ssh()).filter((call) => call.kind === "command").length;
  expect(after).toBe(before + 1);
  links.close();
  await expect(run(["api", "snapshot"])).rejects.toThrow("unavailable");
  expect((await f.ssh()).filter((call) => call.kind === "command")).toHaveLength(after);
});
