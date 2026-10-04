import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { createPreparedNativeHost, type PreparedNativeSession } from "../src/captain/prepared-native-host.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createOpenCodeNativeHost } from "../src/captain/opencode-native-host.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "opencode-root-")));
  roots.push(cwd);
  const executable = await realpath(process.execPath);
  const binding = { runtime: "external" as const, socketPath: "/tmp/owned-herdr.sock", session: "owned" };
  const facts = { pid: 123, uid: process.getuid!(), birth: ["1700000000", "123456"], executable };
  const info = { pane_id: "w1:p1", shell_pid: 123, foreground_process_group_id: 123 };
  const agent: {
    pane_id: string;
    terminal_id: string;
    agent: string;
    agent_session?: { source: string; kind: string; value: string };
  } = { pane_id: "w1:p1", terminal_id: "term_original", agent: "opencode" };
  const socket = {
    destroyed: false,
    readable: true,
    writable: true,
    remoteAddress: "127.0.0.1",
    localAddress: "127.0.0.1",
    remotePort: 40001,
    localPort: 40002,
  };
  let owner = 123;
  const run = vi.fn(async (file: string, args: readonly string[]) => {
    if (file === "/usr/bin/python3") return JSON.stringify(facts);
    if (args.includes("cwd")) return `p123\nn${cwd}\n`;
    return `p${owner}\nn127.0.0.1:40001->127.0.0.1:40002\n`;
  });
  const request = vi.fn(async (_binding: unknown, method: string, params: unknown) => {
    if (method === "layout.apply")
      return { result: { layout: { root: { type: "pane", pane_id: "w1:p1" } } } };
    if (method === "pane.process_info") return { result: { process_info: structuredClone(info) } };
    if (method === "agent.get") return { result: { agent: structuredClone(agent) } };
    if (method === "pane.report_agent") {
      const value = params as {
        source: string;
        agent: string;
        agent_session_id?: string;
        agent_session_path?: string;
      };
      agent.agent = value.agent;
      agent.agent_session = {
        source: value.source,
        kind: value.agent_session_path === undefined ? "id" : "path",
        value: value.agent_session_path ?? value.agent_session_id!,
      };
      return { result: {} };
    }
    throw new Error("Forbidden native method");
  });
  const options = {
    binding: async () => binding,
    processHelper: "/fixed/process-birth.py",
    platform: "darwin",
    run,
    request,
  };
  const host = createOpenCodeNativeHost(options);
  const piHost = createPreparedNativeHost({ ...options, harness: "pi" });
  return {
    piHost,
    host,
    cwd,
    executable,
    facts,
    info,
    agent,
    binding,
    run,
    request,
    socket,
    setOwner: (pid: number) => {
      owner = pid;
    },
    capture: () => host.capture("w1:p1", executable, cwd),
  };
}

test("initial native argv is a single new layout request; never replacement or terminal submission", async () => {
  const f = await fixture();
  expect(
    await f.host.createCommandTab({
      cwd: f.cwd,
      label: "worker",
      command: [f.executable, "--session", "ses_exact1234"],
      env: { FIXTURE: "value" },
    }),
  ).toBe("w1:p1");
  expect(f.request).toHaveBeenCalledExactlyOnceWith(f.binding, "layout.apply", {
    tab_label: "worker",
    focus: false,
    root: {
      type: "pane",
      cwd: f.cwd,
      command: [f.executable, "--session", "ses_exact1234"],
      env: { FIXTURE: "value" },
    },
  });
});

test("lost/malformed allocation reply stays unconfirmed and cannot request a fallback", async () => {
  const f = await fixture();
  f.request.mockRejectedValueOnce(new Error("timeout after allocation"));
  await expect(
    f.host.createCommandTab({ cwd: f.cwd, label: "worker", command: [f.executable] }),
  ).rejects.toThrow("timeout");
  expect(f.request).toHaveBeenCalledTimes(1);
  f.request.mockResolvedValueOnce({ result: {} } as never);
  await expect(
    f.host.createCommandTab({ cwd: f.cwd, label: "worker", command: [f.executable] }),
  ).rejects.toThrow("unconfirmed");
  expect(f.request).toHaveBeenCalledTimes(2); // Two explicitly separate fixture attempts.
});

test("only exact foreground/root socket owner qualifies; birth precision survives the stored proof", async () => {
  const f = await fixture();
  const root = await f.capture();
  expect(await root.check(f.socket as Socket)).toBe(true);
  await root.report("ses_exact1234", "idle");
  expect(await root.proof("ses_exact1234")).toMatchObject({
    pane: "w1:p1",
    shell: { pid: 123, startTime: "1700000000.123456" },
    processes: [{ pid: 123, startTime: "1700000000.123456" }],
  });
  f.setOwner(456);
  expect(await root.check(f.socket as Socket)).toBe(false);
  expect(
    f.run.mock.calls.filter(([file]) => file === "/usr/bin/python3").every(([, args]) => args[0] === "-I"),
  ).toBe(true);
});

test.each([
  "birth",
  "cwd",
  "executable",
  "shell",
  "foreground",
  "terminal",
  "binding",
  "socket",
  "session",
  "uid",
])("%s change revokes original held control", async (change) => {
  const f = await fixture();
  const root = await f.capture();
  await root.report("ses_exact1234", "idle");
  if (change === "birth") f.facts.birth[1] = "123457"; // Same PID, same second, different lifetime.
  if (change === "cwd")
    f.run.mockImplementation(async (file) =>
      file === "/usr/bin/python3" ? JSON.stringify(f.facts) : "p123\nn/tmp\n",
    );
  if (change === "executable") f.facts.executable = "/bin/sh";
  if (change === "shell") f.info.shell_pid = 456;
  if (change === "foreground") f.info.foreground_process_group_id = 456;
  if (change === "terminal") f.agent.terminal_id = "replacement";
  if (change === "binding") f.binding.socketPath = "/tmp/replacement.sock";
  if (change === "socket") f.socket.destroyed = true;
  if (change === "session") f.agent.agent_session!.value = "ses_owner5678";
  if (change === "uid") f.facts.uid += 1;
  expect(await root.check(f.socket as Socket)).toBe(false);
});

test("missing/short process facts and absent foreground fail before binding", async () => {
  const f = await fixture();
  f.run.mockResolvedValueOnce("{}");
  await expect(f.capture()).rejects.toThrow();
  f.info.foreground_process_group_id = 456;
  await expect(f.capture()).rejects.toThrow("not the foreground root");
});

test("Pi path descriptor reports only the native path and preserves original Node lifetime proof", async () => {
  const f = await fixture();
  const root = await f.piHost.capture("w1:p1", f.executable, f.cwd);
  // A fresh native header may exist before its first JSONL write. Producer owns
  // header/UUID/canonical path agreement; no nonexistent file is called saved history.
  const session: PreparedNativeSession = { source: "herdr:pi", kind: "path", value: `${f.cwd}/native.jsonl` };
  await expect(root.proof(session)).rejects.toThrow("not been bound");
  await root.report(session, "idle");
  const report = f.request.mock.calls.find(([, method]) => method === "pane.report_agent")!;
  expect(report[2]).toEqual({
    pane_id: "w1:p1",
    source: "herdr:pi",
    agent: "pi",
    state: "idle",
    agent_session_path: session.value,
  });
  expect(await root.proof(session)).toMatchObject({
    nativeOccupantId: occupantIdForHerdrSession(session),
    shell: { pid: 123, startTime: "1700000000.123456" },
  });
  expect(await root.check(f.socket as Socket)).toBe(true);
  const replacement = { ...session, value: `${f.cwd}/replacement.jsonl` };
  await expect(root.proof(replacement)).rejects.toThrow("not been bound");
  await expect(root.report(replacement, "idle")).rejects.toThrow("retarget");
});

test.each([
  { source: "herdr:opencode", kind: "id", value: "ses_exact1234" },
  { source: "herdr:pi", kind: "id", value: "ses_exact1234" },
  { source: "herdr:pi", kind: "path", value: "relative.jsonl" },
  { source: "herdr:pi", kind: "path", value: "/tmp/../owner.jsonl" },
  { source: "herdr:pi", kind: "path", value: "/tmp/native\0.jsonl" },
])("Pi rejects mismatched/malformed descriptor before reporting: %j", async (session) => {
  const f = await fixture();
  const root = await f.piHost.capture("w1:p1", f.executable, f.cwd);
  await expect(root.report(session as PreparedNativeSession, "idle")).rejects.toThrow();
  expect(f.request.mock.calls.filter(([, method]) => method === "pane.report_agent")).toEqual([]);
});

test.each(["harness", "source", "kind", "path", "birth", "socket", "terminal"])(
  "Pi %s replacement revokes the same held root",
  async (change) => {
    const f = await fixture();
    const root = await f.piHost.capture("w1:p1", f.executable, f.cwd);
    const session = { source: "herdr:pi", kind: "path", value: `${f.cwd}/native.jsonl` } as const;
    await root.report(session, "idle");
    if (change === "harness") f.agent.agent = "opencode";
    if (change === "source") f.agent.agent_session!.source = "hook:pi";
    if (change === "kind") f.agent.agent_session!.kind = "id";
    if (change === "path") f.agent.agent_session!.value = `${f.cwd}/owner.jsonl`;
    if (change === "birth") f.facts.birth[1] = "123457";
    if (change === "socket") f.setOwner(456);
    if (change === "terminal") f.agent.terminal_id = "replacement";
    expect(await root.check(f.socket as Socket)).toBe(false);
    if (change !== "socket") await expect(root.proof(session)).rejects.toThrow();
  },
);
