import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error -- checkout-only manual eval modules are plain ESM.
import { nativeClaudeArmReadiness } from "../../../scripts/evals/lead-native-claude.mjs";
// @ts-expect-error -- checkout-only manual eval modules are plain ESM.
import * as claudeObservation from "../../../scripts/evals/lead-native-claude-observation.mjs";
// @ts-expect-error -- checkout-only manual eval modules are plain ESM.
import * as claudePlan from "../../../scripts/evals/lead-native-claude-plan.mjs";
// @ts-expect-error -- checkout-only manual eval modules are plain ESM.
import { LeadContainer, RUN_LABEL, ROLE_LABEL } from "../../../scripts/evals/lead-containment.mjs";
const { NativeClaudeObservation, inspectNativeClaudeTranscript } = claudeObservation;
const { prepareNativeClaudePlan, stopNativeClaudeArm } = claudePlan;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sessionId = "11223344-1122-1122-1122-112233445566";
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "native-claude-fixture-"));
  roots.push(root);
  for (const path of [
    "control",
    "control/artifacts",
    "tasks",
    "tasks/lead",
    "tasks/lead/.git",
    "tasks/worker-1",
    "tasks/worker-1/.git",
  ])
    mkdirSync(join(root, path), { mode: 0o700 });
  for (const name of ["lead", "worker-1"])
    writeFileSync(join(root, "tasks", name, ".git/index"), "fixture-index", { mode: 0o600 });
  // Harmless fake ELF bytes are selected-input fixtures, never an executable capability.
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]);
  writeFileSync(join(root, "control/artifacts/claude"), elf, { mode: 0o500 });
  return {
    root,
    image: `sha256:${"a".repeat(64)}`,
    executableSha256: createHash("sha256").update(elf).digest("hex"),
    version: "2.1.286",
    sessionId,
    model: "claude-fixture-lead",
    workerModel: "claude-fixture-worker",
    workerCount: 1,
  };
}
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};
function assistant(extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: "record-one",
    sessionId,
    message: { id: "message-one", usage, content: [] },
    ...extra,
  };
}
const bytes = (...records: unknown[]) =>
  Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
const hook = (hook_event_name: string, extra: Record<string, unknown> = {}) => ({
  session_id: sessionId,
  hook_event_name,
  ...extra,
});

it("keeps every imported readiness claim non-authorizing and returns independent blocker copies", () => {
  const result = nativeClaudeArmReadiness({ providerVerified: true, fixture: true, launchAllowed: true });
  expect(result).toMatchObject({
    launchAllowed: false,
    approvalEstablished: false,
    execution: "unrun",
    reason: "native-claude-capabilities-unavailable",
  });
  expect(result.missing.map((item: { code: string }) => item.code)).toContain(
    "claude-physical-request-fence-unavailable",
  );
  result.missing.length = 0;
  expect(nativeClaudeArmReadiness().missing.length).toBe(5);
});
it("writes a scrubbed interactive plan with independent indexes but never authorizes launch", () => {
  const f = fixture(),
    plan = prepareNativeClaudePlan(f);
  expect(plan.launchAllowed).toBe(false);
  expect(plan.argv[0]).toBe("/opt/claude/bin/claude");
  expect(plan.argv).not.toContain("-p");
  expect(plan.argv).not.toContain("--print");
  expect(plan.argv).toContain("--restricted");
  expect(plan.argv).toContain("--strict-mcp-config");
  expect(plan.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(plan.environment).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  expect(plan.settings.disableAllHooks).toBe(true);
  expect(plan.allocations[0].index).not.toEqual(plan.allocations[1].index);
  expect(plan.artifact.versionVerified).toBe(false);
  expect(JSON.parse(readFileSync(join(f.root, "control/claude/launch-plan.json"), "utf8"))).toEqual(plan);
  expect(() => prepareNativeClaudePlan(f)).toThrow();
});
it("refuses changed/native script artifacts, unpinned images, aliases and excessive worker counts", () => {
  for (const override of [
    { executableSha256: "b".repeat(64) },
    { image: "latest" },
    { model: "opus" },
    { workerCount: 7 },
  ])
    expect(() => prepareNativeClaudePlan({ ...fixture(), ...override })).toThrow();
  const f = fixture();
  chmodSync(join(f.root, "control/artifacts/claude"), 0o600);
  writeFileSync(join(f.root, "control/artifacts/claude"), "#!/bin/sh\n");
  expect(() => prepareNativeClaudePlan(f)).toThrow(/ELF/);
});
it("refuses shared indexes, linked worktrees and symlinked control paths", () => {
  const hard = fixture(),
    index = join(hard.root, "tasks/worker-1/.git/index");
  rmSync(index);
  linkSync(join(hard.root, "tasks/lead/.git/index"), index);
  expect(() => prepareNativeClaudePlan(hard)).toThrow(/index/);
  const linked = fixture();
  writeFileSync(join(linked.root, "tasks/worker-1/.git/commondir"), "../../lead/.git");
  expect(() => prepareNativeClaudePlan(linked)).toThrow(/Shared/);
  const sym = fixture();
  rmSync(join(sym.root, "control/artifacts"), { recursive: true });
  symlinkSync(join(sym.root, "tasks"), join(sym.root, "control/artifacts"));
  expect(() => prepareNativeClaudePlan(sym)).toThrow(/Canonical/);
});
it("deduplicates repeated provider message usage and ignores text that claims usage", () => {
  const result = inspectNativeClaudeTranscript(
    bytes(assistant(), assistant({ uuid: "record-two" }), { type: "user", message: { usage } }),
    { sessionId },
  );
  expect(result).toMatchObject({
    observedTokens: 20,
    messageCount: 1,
    complete: false,
    authoritative: false,
    accountWideTokens: null,
  });
});
it("makes conflicting counters, wrong roots, incomplete counters and malformed bytes unknown", () => {
  const cases = [
    bytes(
      assistant(),
      assistant({
        uuid: "record-two",
        message: { id: "message-one", usage: { ...usage, output_tokens: 50 } },
      }),
    ),
    bytes(assistant({ sessionId: "wrong" })),
    bytes(assistant({ message: { id: "one", usage: { input_tokens: 1 } } })),
    Buffer.from('{"type":'),
    bytes(assistant({ message: { id: "one", usage: { ...usage, input_tokens: Number.MAX_SAFE_INTEGER } } })),
  ];
  for (const input of cases)
    expect(inspectNativeClaudeTranscript(input, { sessionId }).observedTokens).toBeNull();
  expect(() => inspectNativeClaudeTranscript(Buffer.from([255]), { sessionId })).toThrow();
});
it("requires child sidechain/agent correlation and excludes unknown child bytes", () => {
  const input = bytes(assistant({ agentId: "child-one", isSidechain: true }));
  expect(inspectNativeClaudeTranscript(input, { sessionId, agentId: "child-one" }).observedTokens).toBe(20);
  expect(inspectNativeClaudeTranscript(input, { sessionId }).observedTokens).toBeNull();
  expect(inspectNativeClaudeTranscript(input, { sessionId, agentId: "other" }).observedTokens).toBeNull();
});
it("root Stop never settles a still-running child or supplies a containment stop receipt", () => {
  const observation = new NativeClaudeObservation({ sessionId });
  observation.observe(hook("SessionStart", { source: "startup" }));
  observation.observe(hook("UserPromptSubmit"));
  observation.observe(hook("SubagentStart", { agent_id: "child-one", agent_type: "worker" }));
  observation.observe(hook("Stop"));
  observation.transcript(bytes(assistant()));
  expect(observation.seal()).toMatchObject({
    observedTokens: null,
    complete: false,
    containmentStopConfirmed: false,
  });
  expect(observation.seal().issues).toContain("child-still-active:child-one");
  expect(() => observation.observe(hook("SubagentStop"))).toThrow(/sealed/);
});
it("sums only observed root/child messages without promoting hook or transcript claims to authority", () => {
  const observation = new NativeClaudeObservation({ sessionId });
  observation.observe(hook("SessionStart", { source: "startup" }));
  observation.observe(hook("UserPromptSubmit"));
  observation.observe(hook("SubagentStart", { agent_id: "child-one", agent_type: "worker" }));
  observation.observe(hook("SubagentStop", { agent_id: "child-one", agent_type: "worker" }));
  observation.observe(hook("Stop"));
  observation.transcript(bytes(assistant()));
  observation.transcript(
    bytes(
      assistant({
        agentId: "child-one",
        isSidechain: true,
        message: { id: "child-message", usage, content: [] },
      }),
    ),
    "child-one",
  );
  const report = observation.seal();
  expect(report).toMatchObject({
    issues: [],
    observedTokens: 40,
    authoritative: false,
    complete: false,
    accountWideTokens: null,
  });
  expect(report.events[1].previous).toBe(report.events[0].sha256);
  report.transcripts[0].observedTokens = 999;
  expect(observation.seal().observedTokens).toBe(40);
});
it("does not normalize duplicate starts, forged child stops, resume or later active turns into complete evidence", () => {
  const observation = new NativeClaudeObservation({ sessionId });
  observation.observe(hook("SessionStart", { source: "resume" }));
  observation.observe(hook("UserPromptSubmit"));
  observation.observe(hook("Stop"));
  observation.observe(hook("SubagentStop", { agent_id: "unknown", agent_type: "worker" }));
  observation.observe(hook("UserPromptSubmit"));
  observation.transcript(bytes(assistant()));
  expect(observation.seal().issues).toEqual(
    expect.arrayContaining([
      "unexpected-root-restart-or-resume",
      "unmatched-child-stop",
      "root-still-active",
    ]),
  );
});
it("rejects fake stop authorities without calling them", async () => {
  await expect(
    stopNativeClaudeArm(
      {
        stop() {
          throw Error("must not run");
        },
      },
      "fixture",
    ),
  ).rejects.toThrow(/LeadContainer/);
});
it("uses exact owned container kill/inspection and retains stop uncertainty (fake transport only)", async () => {
  const f = fixture(),
    containerId = "a".repeat(64),
    image = f.image;
  let running = false,
    killWorks = false;
  const calls: string[][] = [];
  let container: InstanceType<typeof LeadContainer>;
  const command = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "image") return JSON.stringify([{ Id: image, Os: "linux", RepoDigests: [] }]);
    if (args[0] === "create") return containerId;
    if (args[0] === "start") running = true;
    if (args[0] === "kill" && killWorks) running = false;
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: containerId,
          Image: image,
          Config: {
            User: `${process.getuid!()}:${process.getgid!()}`,
            Labels: { [RUN_LABEL]: container.runId, [ROLE_LABEL]: "verifier" },
          },
          HostConfig: {
            Privileged: false,
            ReadonlyRootfs: true,
            NetworkMode: "none",
            PidMode: "",
            CapDrop: ["ALL"],
            SecurityOpt: ["no-new-privileges"],
          },
          Mounts: [{ Type: "bind", Source: f.root, Destination: "/eval", RW: true }],
          State: { Running: running },
        },
      ]);
    return "";
  };
  container = new LeadContainer({ image, root: f.root, command, role: "verifier" });
  await container.create(["/fixture"]);
  await container.start();
  await expect(stopNativeClaudeArm(container, "fixture quota loss")).rejects.toMatchObject({
    code: "native-claude-stop-unconfirmed",
  });
  killWorks = true;
  await expect(stopNativeClaudeArm(container, "do not replay")).rejects.toMatchObject({
    code: "native-claude-stop-unconfirmed",
  });
  expect(calls.filter((args) => args[0] === "kill")).toHaveLength(1);
});
it("bounds aggregate encoded hook bytes even when each event is individually small", () => {
  const observation = new NativeClaudeObservation({ sessionId });
  const event = hook("SessionStart", { source: "startup", fixturePadding: "x".repeat(32 * 1024) });
  expect(() => {
    for (let i = 0; i < 40; i++) observation.observe(event);
  }).toThrow(/aggregate.*capacity/i);
  expect(observation.seal().issues).toContain("aggregate-observation-capacity-exceeded");
});
it("makes repeated provider message identity across root and child copies unknown", () => {
  const observation = new NativeClaudeObservation({ sessionId });
  observation.observe(hook("SessionStart", { source: "startup" }));
  observation.observe(hook("UserPromptSubmit"));
  observation.observe(hook("SubagentStart", { agent_id: "child-one", agent_type: "worker" }));
  observation.observe(hook("SubagentStop", { agent_id: "child-one", agent_type: "worker" }));
  observation.observe(hook("Stop"));
  observation.transcript(bytes(assistant()));
  observation.transcript(bytes(assistant({ agentId: "child-one", isSidechain: true })), "child-one");
  expect(observation.seal()).toMatchObject({
    observedTokens: null,
    issues: expect.arrayContaining(["duplicate-provider-message-across-transcripts"]),
    authoritative: false,
    complete: false,
  });
});
