import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createLocalAgentHost, createSshAgentHost, resolveAgentHost } from "../src/index.ts";

const homes: string[] = [];
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "agent-hosts-"));
  homes.push(home);
  const root = join(home, ".claude", "projects", "project");
  await mkdir(root, { recursive: true });
  const path = join(root, "session ' $(touch escaped).jsonl");
  const bytes = Buffer.from('{"text":"hello 😀"}\n{"text":"next"}\n');
  await writeFile(path, bytes);
  return { home, root, path, bytes };
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("local discovery and byte ranges preserve exact UTF-8 bytes; missing roots are empty", async () => {
  const f = await fixture();
  const host = createLocalAgentHost({ home: f.home });
  const files = await host.list();
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ path: f.path, harness: "claude", size: f.bytes.length });
  expect(await host.readBytes(f.path, 5, 20)).toEqual({
    size: f.bytes.length,
    bytes: f.bytes.subarray(5, 25),
  });
  expect((await host.readBytes(f.path, 999, 10)).bytes.length).toBe(0);
  await expect(host.list({ limit: 0 })).rejects.toThrow("limit");
  await expect(host.readBytes(f.path, -1, 20)).rejects.toThrow("range");
});

test("local reads refuse escaped paths and symlinks outside transcript roots", async () => {
  const f = await fixture();
  const outside = join(f.home, "outside.jsonl");
  await writeFile(outside, "private");
  const linked = join(f.root, "linked.jsonl");
  await symlink(outside, linked);
  const host = createLocalAgentHost({ home: f.home });
  await expect(host.readBytes(outside, 0, 20)).rejects.toThrow("outside");
  await expect(host.readBytes(linked, 0, 20)).rejects.toThrow("outside");
  expect(await host.list()).toHaveLength(1);
});

test("POSIX wire commands execute safely with spaces, quotes, and shell substitutions", async () => {
  const f = await fixture();
  const run = async (command: string, args: string[]) => {
    expect(command).toBe("ssh");
    expect(args.slice(0, -1)).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "--",
      "test-host",
    ]);
    return (await promisify(execFile)("sh", ["-c", args.at(-1)!], { env: { ...process.env, HOME: f.home } }))
      .stdout;
  };
  const host = createSshAgentHost({ id: "test", ssh: "test-host", shell: "posix" }, { run });
  expect((await host.list())[0]).toMatchObject({ path: f.path, size: f.bytes.length, harness: "claude" });
  expect(await host.readBytes(f.path, 3, 23)).toEqual({
    size: f.bytes.length,
    bytes: f.bytes.subarray(3, 26),
  });
  const outside = join(f.home, "outside.jsonl");
  await writeFile(outside, "private");
  await expect(host.readBytes(outside, 0, 10)).rejects.toThrow();
  const linked = join(f.root, "linked.jsonl");
  await symlink(outside, linked);
  await expect(host.readBytes(linked, 0, 10)).rejects.toThrow();
});

test("PowerShell uses encoded commands and escaped literals; responses remain bounded", async () => {
  const commands: string[] = [];
  const host = createSshAgentHost(
    { id: "pc", ssh: "volpe@pc", shell: "powershell" },
    {
      run: async (_, args) => {
        const command = args.at(-1)!;
        expect(command).toMatch(/^powershell.exe -NoProfile -NonInteractive -EncodedCommand /);
        const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
        commands.push(script);
        return script.includes("ConvertTo-Json") ? "[]\r\n" : "5\r\naGVsbG8=";
      },
    },
  );
  expect(await host.list()).toEqual([]);
  expect(await host.readBytes("C:\\Users\\volpe\\.claude\\projects\\it's.jsonl", 0, 10)).toEqual({
    size: 5,
    bytes: Buffer.from("hello"),
  });
  expect(commands[1]).toContain("it''s.jsonl");
  expect(commands[1]).toContain("ReparsePoint");
  await expect(host.readBytes("C:\\x.jsonl", 0, 4)).rejects.toThrow("Oversized");
});

test("unknown hosts and SSH option injection are rejected without connecting", () => {
  expect(() => resolveAgentHost("missing", [])).toThrow("Unknown");
  expect(() => createSshAgentHost({ id: "pc", ssh: "-oProxyCommand=evil", shell: "posix" })).toThrow(
    "Invalid SSH",
  );
  expect(() => createSshAgentHost({ id: "local", ssh: "pc", shell: "posix" })).toThrow("Invalid remote");
});

test("remote malformed listings and byte responses fail closed", async () => {
  let output = '[{"harness":"claude","path":"x.jsonl","size":-1,"mtimeMs":0}]';
  const host = createSshAgentHost({ id: "pc", ssh: "pc", shell: "powershell" }, { run: async () => output });
  await expect(host.list()).rejects.toThrow("metadata");
  for (const bad of ["\n", "12\na", "12\n!!!!", "-1\naGVsbG8=", "5\nab=="]) {
    output = bad;
    await expect(host.readBytes("C:\\file.jsonl", 0, 100)).rejects.toThrow("Invalid remote");
  }
});
