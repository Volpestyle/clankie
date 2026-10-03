import { expect, test, vi } from "vitest";
vi.mock("../../../scripts/evals/lead-native-capability.mjs", () => ({
  nativeRuntimeEvidence: () => ({
    codingHelper: {
      sha256: "fixture",
      supervisorSha256: "fixture-supervisor",
      descendantSettlement: { namespaceGone: true, noLateWrite: true },
    },
    source: { codingHelper: "fixture", codingSupervisor: "fixture-supervisor" },
    binaries: {
      "/usr/local/lib/lead-coding-helper.mjs": "fixture",
      "/usr/local/lib/lead-coding-supervisor.mjs": "fixture-supervisor",
    },
  }),
}));
// @ts-expect-error -- capability is explicitly substituted; these fixtures prove SDK wiring only.
import { createContainedCodingTools } from "../../../scripts/evals/lead-coding-tools.mjs";

function fixture() {
  const requests: any[] = [];
  let settled = true;
  const stop = vi.fn(async () => {});
  const exec = vi.fn(async (argv: string[], options?: { input?: string; signal?: AbortSignal }) => {
    if (!options?.input) return settled ? "settled" : "uncertain";
    expect(argv).toContain("/usr/local/lib/lead-coding-supervisor.mjs");

    const input = JSON.parse(options.input);
    requests.push(input);
    if (options.signal?.aborted) throw Error("cancelled fixture");
    return JSON.stringify({
      settlement: { complete: settled, namespace: "pid:[42]", helperPid: 42, helperStart: "10" },
      result:
        input.op === "read"
          ? { content: "contained text" }
          : input.op === "bash"
            ? { output: "contained output", exitCode: 0 }
            : { ok: true },
    });
  });
  const admit = vi.fn(async () => {});
  const tools = createContainedCodingTools({
    cwd: "/eval/tasks/lead",
    container: { exec, stop, capability: {} },
    admit,
  });
  return {
    tools,
    requests,
    stop,
    exec,
    admit,
    unsettle: () => {
      settled = false;
    },
  };
}

test("actual Pi coding definitions use contained operations including access/read/mkdir/write", async () => {
  const f = fixture();
  const run = (name: string, params: unknown) =>
    f.tools.find((tool: any) => tool.name === name).execute("fixture", params, undefined, undefined, {});
  const read = await run("read", { path: "notes.txt" });
  expect(read.content[0].text).toContain("contained text");
  await run("write", { path: "notes.txt", content: "new text" });
  await run("bash", { command: "printf fixture" });
  expect(f.requests).toEqual([
    { op: "access", path: "/eval/tasks/lead/notes.txt" },
    { op: "read", path: "/eval/tasks/lead/notes.txt" },
    { op: "mkdir", path: "/eval/tasks/lead" },
    { op: "write", path: "/eval/tasks/lead/notes.txt", content: "new text" },
    { op: "bash", command: "printf fixture" },
  ]);
  expect(f.exec.mock.calls.filter((call) => call[1]?.input === undefined)).toHaveLength(0);
  expect(f.stop).not.toHaveBeenCalled();
});
test("unknown descendant settlement closes the exact container before tool failure", async () => {
  const f = fixture();
  f.unsettle();
  await expect(
    f.tools.find((tool: any) => tool.name === "bash").execute("fixture", { command: "ignored" }),
  ).rejects.toThrow("settlement");
  expect(f.stop).toHaveBeenCalledOnce();
});
test("cancellation never starts helper and latches boundary stop", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.tools
      .find((tool: any) => tool.name === "bash")
      .execute("fixture", { command: "ignored" }, controller.signal),
  ).rejects.toThrow("cancelled");
  expect(f.exec).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledOnce();
});
