import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { afterEach, expect, test, vi } from "vitest";
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
      const value = params as { agent_session_id: string };
      agent.agent_session = { source: "herdr:opencode", kind: "id", value: value.agent_session_id };
      return { result: {} };
    }
    throw new Error("Forbidden native method");
  });
  const host = createOpenCodeNativeHost({
    binding: async () => binding,
    processHelper: "/fixed/process-birth.py",
    platform: "darwin",
    run,
    request,
  });
  return {
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
