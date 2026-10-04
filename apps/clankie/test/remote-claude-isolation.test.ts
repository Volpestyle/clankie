import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { SeatHookLog } from "../src/captain/claude-worker-seat.ts";
import {
  createRemoteClaudeWorkerSeatAdapter,
  remoteClaudeTrackerDeny,
} from "../src/captain/remote-claude-worker.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const fleet: HerdrFleet = {
  id: "fixture",
  session: "default",
  ssh: { host: "fixture.invalid", shell: "posix" },
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("denies an alias-named project Linear URL from the exact generated collector", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-remote-isolation-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "repo", "nested");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(home, ".claude.json"), "{}");
  await writeFile(
    join(root, "repo", ".mcp.json"),
    JSON.stringify({ mcpServers: { issues: { url: "https://mcp.linear.app/mcp" } } }),
  );
  const shell = async (command: string, timeout?: number) =>
    (
      await exec("/bin/sh", ["-c", command], {
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
        timeout: timeout ?? 10_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  expect(await remoteClaudeTrackerDeny(fleet, shell)(cwd)).toContain("mcp__issues");
});

async function generated(cwd = "C:\\repo\\nested") {
  let command = "";
  await remoteClaudeTrackerDeny(
    { ...fleet, ssh: { ...fleet.ssh, shell: "powershell" } },
    async (value, timeout) => {
      command = value;
      expect(timeout).toBe(10_000);
      return JSON.stringify({ schemaVersion: 1, sources: [] });
    },
  )(cwd);
  expect(command.length).toBeLessThan(30_000);
  const ps = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  const encoded = /FromBase64String\('([^']+)'\)/u.exec(ps)?.[1];
  if (!encoded) throw new Error("Missing argv envelope");
  const line = Buffer.from(encoded, "base64").toString("utf8");
  const argv: string[] = [];
  let token = "",
    quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      let count = 1;
      while (line[i + 1] === "\\") {
        count++;
        i++;
      }
      if (line[i + 1] === '"') {
        token += "\\".repeat(Math.floor(count / 2));
        if (count % 2) {
          token += '"';
          i++;
        }
      } else token += "\\".repeat(count);
    } else if (ch === '"') quoted = !quoted;
    else if (ch === " " && !quoted) {
      argv.push(token);
      token = "";
    } else token += ch;
  }
  argv.push(token);
  expect(argv[0]).toBe("-e");
  expect(argv).toHaveLength(3);
  return { code: argv[1]!, input: argv[2]!, command };
}

type FakeFile = string | { error: string } | { directory: boolean };
async function windowsRead(
  files: Record<string, FakeFile>,
  options: { cwd?: string; configDir?: string; platform?: string } = {},
) {
  const { code, input } = await generated(options.cwd);
  const opened: string[] = [];
  const handles = new Map<number, Buffer>();
  const normalized = new Map(
    Object.entries(files).map(([p, value]) => [win32.normalize(p).toLowerCase(), value]),
  );
  const error = (code: string): never => {
    throw Object.assign(new Error("private fixture contents"), { code });
  };
  const stats = (fd: number) => {
    const buffer = handles.get(fd)!;
    return { isFile: () => buffer !== undefined, size: buffer?.length ?? 0, mtimeMs: 1 };
  };
  const fs = {
    constants: { O_RDONLY: 0, O_NONBLOCK: 2048 },
    openSync(path: string, flags: number) {
      expect(flags).toBe(2048);
      opened.push(path);
      const file = normalized.get(win32.normalize(path).toLowerCase());
      if (file === undefined) return error("ENOENT");
      if (typeof file !== "string") {
        if ("error" in file) return error(file.error);
        const fd = handles.size + 1;
        handles.set(fd, undefined as unknown as Buffer);
        return fd;
      }
      const fd = handles.size + 1;
      handles.set(fd, Buffer.from(file));
      return fd;
    },
    lstatSync(path: string) {
      if (!normalized.has(win32.normalize(path).toLowerCase())) return error("ENOENT");
      return {};
    },
    fstatSync: stats,
    readSync(fd: number, buffer: Buffer, offset: number, length: number) {
      return handles.get(fd)!.copy(buffer, offset, offset, offset + length);
    },
    closeSync: vi.fn(),
  };
  let stdout = "",
    stderr = "";
  const process = {
    platform: options.platform ?? "win32",
    argv: ["node", input],
    env: { USERPROFILE: "C:\\home", CLAUDE_CONFIG_DIR: options.configDir },
    stdout: {
      write: (value: string) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value: string) => {
        stderr += value;
      },
    },
    exitCode: 0,
  };
  runInNewContext(
    code,
    {
      require: (name: string) => {
        if (name === "node:fs") return fs;
        if (name === "node:path") return win32;
        throw new Error("Unexpected module");
      },
      process,
      Buffer,
      URL,
      TextDecoder,
    },
    { timeout: 1_000 },
  );
  return { stdout, stderr, opened, exitCode: process.exitCode, closed: fs.closeSync.mock.calls.length };
}

const config = (name: string, fields: Record<string, unknown> = { url: "https://mcp.linear.app/mcp" }) =>
  JSON.stringify({ mcpServers: { [name]: fields } });

it("collects default/configured profiles and only applicable project maps on Windows", async () => {
  const read = await windowsRead(
    {
      "C:\\home\\.claude.json": JSON.stringify({
        mcpServers: { personal: { url: "https://linear.app/mcp" } },
        projects: {
          "c:/REPO/": { mcpServers: { inherited: { args: ["@linear/tool"] } } },
          "C:\\repo-other": { mcpServers: { sibling: { command: "linear-mcp" } } },
        },
      }),
      "D:\\selected\\.claude.json": config("selected"),
      "C:\\repo\\nested\\.mcp.json": config("cwd"),
      "C:\\repo\\.mcp.json": config("parent"),
      "C:\\.mcp.json": config("drive"),
    },
    { configDir: "D:\\selected" },
  );
  expect(read.exitCode).toBe(0);
  const deny = await remoteClaudeTrackerDeny(
    { ...fleet, ssh: { ...fleet.ssh, shell: "powershell" } },
    async () => read.stdout,
  )("C:\\repo\\nested");
  expect(deny).toEqual([
    "mcp__claude_ai_Linear",
    "mcp__cwd",
    "mcp__drive",
    "mcp__inherited",
    "mcp__parent",
    "mcp__personal",
    "mcp__selected",
  ]);
  expect(read.opened).not.toContain("C:\\repo-other\\.mcp.json");
  expect(read.closed).toBe(5);
});

it.each(["C:\\", "\\\\host\\share\\", "\\\\host\\share\\nested"])(
  "terminates at the native drive/share root %s",
  async (cwd) => {
    const read = await windowsRead({}, { cwd });
    expect(read.exitCode).toBe(0);
    expect(read.opened.filter((p) => p.endsWith(".mcp.json"))).toEqual(
      cwd.endsWith("nested")
        ? ["\\\\host\\share\\nested\\.mcp.json", "\\\\host\\share\\.mcp.json"]
        : [win32.join(cwd, ".mcp.json")],
    );
  },
);

it("keeps shell metacharacters literal through the exact Windows argv envelope", async () => {
  const cwd = "C:\\repo\\a' ; $(touch nope) & %PATH% " + String.fromCharCode(96) + "x";
  const read = await windowsRead({ [win32.join(cwd, ".mcp.json")]: config("literal") }, { cwd });
  expect(read.exitCode).toBe(0);
  expect(read.opened).toContain(win32.join(cwd, ".mcp.json"));
  expect(JSON.parse(read.stdout).sources).toContainEqual({ literal: { url: "https://mcp.linear.app" } });
});

it("returns only identifiers, URL hosts and fixed command markers", async () => {
  const read = await windowsRead({
    "C:\\home\\.claude.json": JSON.stringify({
      mcpServers: {
        url: { url: "https://user:fake-password@mcp.linear.app/private?token=fake-query#private" },
        argv: {
          command: "node",
          args: ["linear-mcp", "--token", "fake-argument"],
          env: { SECRET: "fake-env" },
        },
        other: { command: "node", args: ["private-program", "fake-other"] },
      },
    }),
  });
  expect(read.exitCode).toBe(0);
  expect(JSON.parse(read.stdout).sources).toEqual([
    {
      url: { url: "https://mcp.linear.app" },
      argv: { command: "linear-mcp" },
      other: {},
    },
  ]);
  expect(read.stdout + read.stderr).not.toMatch(/fake-|private|--token/u);
});

it.each([
  "{bad",
  "null",
  "[]",
  '{"mcpServers":[]}',
  '{"mcpServers":{"x":null}}',
  '{"mcpServers":{"x":{"args":[{}]}}}',
  " ".repeat(262145),
  { error: "EACCES" },
  { error: "ENOENT" },
  { directory: true },
])("rejects a malformed, unreadable, dangling, nonregular or oversized present source %#", async (file) => {
  const read = await windowsRead({ "C:\\home\\.claude.json": file });
  expect(read.exitCode).toBe(1);
  expect(read.stdout).toBe("");
  expect(read.stderr).toBe("Claude tracker configuration unavailable\n");
});

it("rejects total file bytes, ancestor depth, output and native-platform mismatch", async () => {
  const cwd = "C:\\" + Array.from({ length: 12 }, (_, i) => "d" + i).join("\\");
  const files: Record<string, FakeFile> = {};
  let current = cwd;
  for (let i = 0; i < 10; i++) {
    files[win32.join(current, ".mcp.json")] = JSON.stringify({ unused: "x".repeat(240_000) });
    current = win32.dirname(current);
  }
  expect((await windowsRead(files, { cwd })).exitCode).toBe(1);
  expect((await windowsRead({}, { cwd: "C:\\" + "d\\".repeat(65) })).opened).toHaveLength(0);
  expect((await windowsRead({}, { platform: "darwin" })).exitCode).toBe(1);
  const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [("x" + i).padEnd(500, "x"), {}]));
  const body = JSON.stringify({ mcpServers: many });
  expect(
    (
      await windowsRead({
        "C:\\home\\.claude.json": body,
        "C:\\repo\\.mcp.json": body,
        "C:\\repo\\nested\\.mcp.json": body,
      })
    ).exitCode,
  ).toBe(1);
});

it.each(["relative", "C:relative", "\\root-relative", "\\\\?\\C:\\repo", "\\\\.\\pipe\\x"])(
  "rejects unsupported Windows path %s",
  async (cwd) => {
    if (win32.isAbsolute(cwd)) expect((await windowsRead({}, { cwd })).exitCode).toBe(1);
    else await expect(generated(cwd)).rejects.toThrow(/configuration/u);
  },
);

it.each(["null", "[]", '{"schemaVersion":1,"sources":[null]}', " ".repeat(524289)])(
  "rejects malformed or excessive collector output %# without disclosing it",
  async (output) => {
    await expect(remoteClaudeTrackerDeny(fleet, async () => output)("/repo")).rejects.toThrow(
      "Could not read Claude's configuration on fixture to switch off Linear connectors",
    );
  },
);

it.each(["unavailable", "malformed", "oversized"])(
  "fails before native start or settings write: %s",
  async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "clankie-remote-prelaunch-"));
    roots.push(root);
    const shell = vi
      .fn()
      .mockResolvedValueOnce(
        '---CLANKIE-PLUGINS---\n[{"id":"clankie-worker@clankie"}]\n---CLANKIE-POLICY---\n{"channelsEnabled":true,"allowedChannelPlugins":[{"marketplace":"clankie","plugin":"clankie-worker"}]}',
      );
    if (failure === "unavailable")
      shell.mockRejectedValueOnce(new Error("fake-secret unreadable owner config"));
    else shell.mockResolvedValueOnce(failure === "malformed" ? "{fake-secret" : " ".repeat(524289));
    const adapter = createRemoteClaudeWorkerSeatAdapter(fleet, shell, {
      hooks: new SeatHookLog(join(root, "hooks.json")),
      agent: async () => undefined,
      transcript: async () => undefined,
      mailbox: { bound: () => false, deliver: async () => false },
    });
    const start = vi.fn();
    const result = await adapter.start(
      { harness: "claude", cwd: "/repo", brief: "brief" },
      { paneId: "fixture/w1:p1", start, run: vi.fn() },
    );
    expect(result).toMatchObject({ outcome: "failed", reason: "not_ready" });
    expect(JSON.stringify(result)).not.toContain("fake-secret");
    expect(start).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledTimes(2);
  },
);

it("reads both POSIX profiles and literal quoted ancestors without writing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-posix-isolation-"));
  roots.push(root);
  const home = join(root, "home"),
    selected = join(root, "selected");
  const parent = join(root, "repo' $(not-a-command) ; &");
  const cwd = join(parent, "nested");
  await Promise.all([home, selected, cwd].map((p) => mkdir(p, { recursive: true })));
  const files = new Map([
    [
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { ordinary: { url: "https://linear.app/mcp" } },
        projects: {
          [parent + "/"]: { mcpServers: { mapped: { command: "linear-mcp" } } },
          [parent + "-sibling"]: { mcpServers: { excluded: { command: "linear-mcp" } } },
        },
      }),
    ],
    [join(selected, ".claude.json"), config("selected")],
    [join(parent, ".mcp.json"), config("ancestor")],
    [join(cwd, ".mcp.json"), config("leaf")],
  ]);
  await Promise.all([...files].map(([path, body]) => writeFile(path, body)));
  const calls: string[] = [];
  const shell = async (command: string, timeout?: number) => {
    calls.push(command);
    expect(timeout).toBe(10_000);
    return (
      await exec("/bin/sh", ["-c", command], {
        env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, CLAUDE_CONFIG_DIR: selected },
        timeout,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  };
  expect(await remoteClaudeTrackerDeny(fleet, shell)(cwd)).toEqual([
    "mcp__ancestor",
    "mcp__claude_ai_Linear",
    "mcp__leaf",
    "mcp__mapped",
    "mcp__ordinary",
    "mcp__selected",
  ]);
  expect(calls).toHaveLength(1);
  for (const [file, before] of files) expect(await readFile(file, "utf8")).toBe(before);
});

it("refuses an excessive Windows command before SSH", async () => {
  const shell = vi.fn();
  const cwd = "C:\\" + "'\\\"".repeat(1_200);
  await expect(
    remoteClaudeTrackerDeny({ ...fleet, ssh: { ...fleet.ssh, shell: "powershell" } }, shell)(cwd),
  ).rejects.toThrow(/configuration/u);
  expect(shell).not.toHaveBeenCalled();
});

it("refuses the exact __proto__ Linear alias rather than silently dropping its deny rule", async () => {
  const read = await windowsRead({
    "C:\\home\\.claude.json":
      '{"mcpServers":{"__proto__":{"url":"https://mcp.linear.app/mcp"},"ordinary":{"url":"https://example.invalid"}}}',
  });
  expect(read.exitCode).toBe(0);
  const source = JSON.parse(read.stdout).sources[0];
  expect(Object.hasOwn(source, "__proto__")).toBe(true);
  expect(source.__proto__).toEqual({ url: "https://mcp.linear.app" });
  await expect(
    remoteClaudeTrackerDeny(
      { ...fleet, ssh: { ...fleet.ssh, shell: "powershell" } },
      async () => read.stdout,
    )("C:\\repo\\nested"),
  ).rejects.toThrow("Could not read Claude's configuration on fixture to switch off Linear connectors");
});
