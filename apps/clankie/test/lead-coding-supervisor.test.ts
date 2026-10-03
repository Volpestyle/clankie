import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ nonce: "", released: false, closed: false, command: "" }));
vi.mock("node:child_process", () => ({
  spawn: (_file: string, _args: string[], options: any) => {
    state.nonce = options.env.LEAD_OPERATION_NONCE;
    const child = Object.assign(new EventEmitter(), {
      pid: 20,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on("data", (chunk) => {
      state.command += chunk.toString();
    });
    child.stdin.on("finish", () => {
      state.released = true;
      state.closed = true;
      child.stdout.write(JSON.stringify({ output: "fixture", exitCode: 0, namespace: "pid:[FORGED]" }));
      child.emit("close", 0, null);
    });
    return child;
  },
}));
vi.mock("node:fs/promises", () => ({
  readdir: async () => (state.closed ? ["1"] : ["1", "20", "21"]),
  readFile: async (path: string, encoding?: string) => {
    const pid = Number(path.split("/")[2]);
    let value = "";
    if (path.endsWith("/stat")) {
      const fields = Array(20).fill("0");
      fields[0] = "S";
      fields[1] = pid === 21 ? "20" : "1";
      fields[19] = String(pid * 10);
      value = `${pid} (fixture) ${fields.join(" ")}`;
    }
    if (path.endsWith("/cmdline"))
      value =
        pid === 21
          ? "/usr/local/bin/node\0/usr/local/lib/lead-coding-helper.mjs\0"
          : "/opt/codex/bin/codex\0";
    if (path.endsWith("/environ")) value = `LEAD_OPERATION_NONCE=${state.nonce}\0`;
    return encoding ? value : Buffer.from(value);
  },
  readlink: async (path: string) => {
    const pid = Number(path.split("/")[2]);
    if (path.endsWith("/ns/pid")) return pid === 21 ? "pid:[42]" : "pid:[1]";
    if (path.endsWith("/exe")) return pid === 21 ? "/usr/local/bin/node" : "/opt/codex/bin/codex";
    return "/eval/tasks/lead";
  },
}));
// @ts-expect-error -- exact controller supervisor with fake kernel/process fixtures.
import { waitingHelper, superviseCodingOperation } from "../../../scripts/evals/lead-coding-supervisor.mjs";
const root = {
  pid: 20,
  ppid: 1,
  start: "200",
  argv: ["/opt/codex/bin/codex"],
  nonce: "nonce",
  namespace: "pid:[1]",
};
const helper = {
  pid: 21,
  ppid: 20,
  start: "210",
  argv: ["/usr/local/bin/node", "/usr/local/lib/lead-coding-helper.mjs"],
  exe: "/usr/local/bin/node",
  cwd: "/eval/tasks/lead",
  nonce: "nonce",
  namespace: "pid:[42]",
};
const input = { pid: 20, start: "200", nonce: "nonce", cwd: "/eval/tasks/lead", outerNamespace: "pid:[1]" };
test("kernel identity rejects unknown/reused launcher, duplicate helpers and foreign ancestry", () => {
  expect(waitingHelper([root, helper], input)).toMatchObject({
    namespace: "pid:[42]",
    helperPid: 21,
    helperStart: "210",
  });
  for (const rows of [
    [helper],
    [{ ...root, start: "changed" }, helper],
    [root, helper, { ...helper, pid: 22 }],
    [root, { ...helper, ppid: 99 }],
    [root, { ...helper, nonce: "forged" }],
    [root, { ...helper, namespace: "pid:[1]" }],
  ])
    expect(() => waitingHelper(rows, input)).toThrow();
});
test("actual supervisor releases input only after independent kernel proof and ignores forged result namespace", async () => {
  state.closed = false;
  state.released = false;
  state.command = "";
  const result = await superviseCodingOperation(
    "/eval/tasks/lead",
    Buffer.from('{"op":"bash","command":"untrusted data"}'),
  );
  expect(state.released).toBe(true);
  expect(state.command).toContain("untrusted data");
  expect(result).toEqual({
    result: { output: "fixture", exitCode: 0 },
    settlement: { namespace: "pid:[42]", helperPid: 21, helperStart: "210", complete: true },
  });
});
