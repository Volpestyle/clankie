import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { SeatQuestion, SeatRef } from "@clankie/agent-hosts";
import { FleetSeatHookSchema, type FleetSeatHook } from "@clankie/protocol";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";

const command = fileURLToPath(
  new URL("../../../integrations/claude-plugin/worker/bin/seat-hook.mjs", import.meta.url),
);
const ref: SeatRef = { harness: "claude", paneId: "command-worker", sessionId: "native-command-session" };

/** The installed command reads stdin, authenticates over HTTP and writes native hook JSON. */
async function commandRoundTrip(
  input: Record<string, unknown>,
  selections: readonly string[],
  route: "owned" | "unowned" | "failed" = "owned",
) {
  const root = await mkdtemp(join(tmpdir(), "claude-hook-command-"));
  const registry = new ClaudeHookQuestions(join(root, "used.json"));
  const token = "local-test-token-with-at-least-thirty-two-characters";
  const socket = join(root, "herdr.sock");
  const agent: HerdrAgentSnapshot = {
    paneId: ref.paneId,
    terminalId: "term_1928",
    agent: "claude",
    status: "working",
    title: "Lead",
    session: { source: "herdr:claude", kind: "id", value: ref.sessionId },
  };
  const watchesPath = join(root, "watches.json");
  if (route !== "unowned")
    await writeFile(
      `${watchesPath}.owners.json`,
      JSON.stringify({
        schemaVersion: 1,
        hires: [
          {
            id: "owned-hook-seat",
            paneId: ref.paneId,
            seatId: agent.terminalId,
            occupantId: occupantIdForHerdrSession(agent.session!),
            owner: { conversationId: "exact-lead" },
          },
        ],
      }),
    );
  // Native inventory fixture at the Herdr boundary; routing and its ownership journal are real.
  const watches = new HerdrWatchStore(watchesPath, {
    runner: {
      get: async () => agent,
      resolveTerminal: async () => agent,
      wait: async () => {
        throw new Error("No watch is armed in this command fixture");
      },
    },
  });
  watches.permissionLeadAllowed = async () => true;
  watches.start(async (conversationId, prompt, _discord, guard) => {
    expect(conversationId).toBe("exact-lead");
    await guard?.();
    if (route === "failed")
      throw new Error("lead notification failed", {
        cause: new Error("ECONNREFUSED authorization: Bearer private-notification-token"),
      });
    expect(prompt).toContain("<seat-question>");
  });
  let observedHook: FleetSeatHook | undefined;
  let announce!: (value: { question: SeatQuestion; hook: FleetSeatHook }) => void;
  let rejectAnnouncement!: (error: unknown) => void;
  const announced = new Promise<{ question: SeatQuestion; hook: FleetSeatHook }>((resolve, reject) => {
    announce = resolve;
    rejectAnnouncement = reject;
  });
  const server = createServer((request, response) => {
    void (async () => {
      try {
        expect(request.method).toBe("POST");
        expect(request.url).toBe(`/v1/fleet/seats/${ref.paneId}/hook`);
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const hook = FleetSeatHookSchema.parse(JSON.parse(body));
        if (hook.deliveredQuestionId) {
          expect(registry.acknowledge(ref, hook.deliveredQuestionId)).toBe(true);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        observedHook = hook;
        const hookOutput = await registry.open(ref, hook, async (question) => {
          await watches.forwardNativeQuestion(ref, question);
          announce({ question, hook });
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, hookOutput }));
      } catch (error) {
        rejectAnnouncement(error);
        response.writeHead(500);
        response.end("hook failed");
      }
    })();
  });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    await mkdir(join(root, "links"));
    await writeFile(
      join(root, "links", "test-fleet.json"),
      JSON.stringify({
        schemaVersion: 1,
        fleet: "test-fleet",
        socket,
        url: `http://127.0.0.1:${port}`,
        token,
      }),
    );
    child = spawn(process.execPath, [command], {
      env: { ...process.env, CLANKIE_STATE: root, HERDR_PANE_ID: ref.paneId, HERDR_SOCKET_PATH: socket },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", resolve);
    });
    child.stdin!.end(JSON.stringify({ session_id: ref.sessionId, ...input }));
    if (route !== "owned") {
      expect(await exited).toBe(0);
      expect(stderr).toBe("");
      expect(observedHook).toBeDefined();
      const replay = await registry.open(ref, observedHook!, async () => {
        throw new Error("A consumed failed notification must not be sent again");
      });
      expect(
        replay.hookSpecificOutput.permissionDecisionReason ?? replay.hookSpecificOutput.decision?.message,
      ).toBe("claude_hook_question_already_resolved_or_pending");
      return {
        output: JSON.parse(stdout) as Record<string, unknown>,
        hook: observedHook!,
        question: undefined,
      };
    }
    const { hook, question } = await announced;
    expect(hook.sessionId).toBe(ref.sessionId);
    const answers = Object.fromEntries(
      question.questions.map((q, index) => [q.id, { answers: [selections[index]!] }]),
    );
    expect(
      await registry.answer(ref, { requestId: question.requestId, answers }, undefined, {
        kind: "owner",
        principal: { kind: "operator", id: "test-owner" },
      }),
    ).toEqual({
      outcome: "answered",
      deliveryStage: "responded",
    });
    expect(await exited).toBe(0);
    expect(stderr).toBe("");
    expect(await registry.answer(ref, { requestId: question.requestId, answers })).toMatchObject({
      outcome: "refused",
    });
    return { output: JSON.parse(stdout) as Record<string, unknown>, hook, question };
  } finally {
    watches.close();
    if (child?.exitCode === null && child.signalCode === null) child.kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

it.each(["Allow", "Deny"])(
  "returns %s through a real permission command hook and HTTP response",
  async (selection) => {
    const { output, hook, question } = await commandRoundTrip(
      { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git push" } },
      [selection],
    );
    expect(hook.toolUseId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
    expect(hook.toolInput).toEqual({ command: "git push" });
    expect(question!.questions[0]?.options?.map((option) => option.label)).toEqual(["Allow", "Deny"]);
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: selection === "Allow" ? "allow" : "deny" },
      },
    });
  },
);

it("preserves native AskUserQuestion ID, options and original inputs while returning text-keyed answers", async () => {
  const questions = [
    {
      question: "Which framework?",
      header: "Framework",
      options: [
        { label: "React", description: "Component library" },
        { label: "Vue", description: "Progressive framework" },
      ],
      multiSelect: false,
    },
  ];
  const { output, hook, question } = await commandRoundTrip(
    {
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_native_framework",
      tool_input: { questions },
    },
    ["React"],
  );
  expect(hook.toolUseId).toBe("toolu_native_framework");
  expect(question!.itemId).toBe("toolu_native_framework");
  expect(question!.questions[0]?.options).toEqual(questions[0]!.options);
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Which framework?": "React" } },
    },
  });
});

const nativeAsk = {
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_unowned",
  tool_input: {
    questions: [
      {
        question: "Which framework?",
        header: "Framework",
        options: [
          { label: "React", description: "Component library" },
          { label: "Vue", description: "Progressive framework" },
        ],
      },
    ],
  },
};

it("lets an unowned operator AskUserQuestion run natively, without supplied answers or a false acknowledgment", async () => {
  const { output } = await commandRoundTrip(nativeAsk, [], "unowned");
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: expect.stringContaining("Native question has no exact hiring conversation"),
    },
  });
});

it.each(["unowned", "failed"] as const)(
  "keeps permission notifications fail-closed on the %s route and carries a redacted cause",
  async (route) => {
    const { output } = await commandRoundTrip(
      {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "git push" },
      },
      [],
      route,
    );
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: expect.stringContaining(
            route === "unowned"
              ? "Native question has no exact hiring conversation"
              : "ECONNREFUSED authorization: [REDACTED]",
          ),
        },
      },
    });
    expect(JSON.stringify(output)).not.toContain("private-notification-token");
  },
);

it("denies an owned AskUserQuestion when its lead notification fails and retains the cause", async () => {
  const { output } = await commandRoundTrip(nativeAsk, [], "failed");
  expect(output).toMatchObject({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("ECONNREFUSED authorization: [REDACTED]"),
    },
  });
});

it("writes the bounded redacted notify cause to the real service stderr as well as the denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-notify-log-"));
  try {
    const source = new URL("../src/captain/claude-hook-questions.ts", import.meta.url).href;
    const program = `
      import { ClaudeHookQuestions } from ${JSON.stringify(source)};
      const registry = new ClaudeHookQuestions(${JSON.stringify(join(root, "used.json"))});
      const result = await registry.open(${JSON.stringify(ref)}, {
        schemaVersion: 1, sessionId: ${JSON.stringify(ref.sessionId)}, event: "PermissionRequest",
        toolName: "Bash", toolUseId: "logged-notify-failure", toolInput: { command: "git push" },
      }, async () => { throw new Error("lead notification failed", {
        cause: new Error("ECONNREFUSED authorization: Bearer private-notification-token"),
      }); });
      console.log(JSON.stringify(result));
    `;
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", program],
      {
        timeout: 10_000,
        encoding: "utf8",
      },
    );
    const reason = JSON.parse(stdout).hookSpecificOutput.decision.message as string;
    expect(reason).toContain("ECONNREFUSED authorization: [REDACTED]");
    expect(stderr).toContain("Claude question notification failed");
    expect(stderr).toContain(reason);
    expect(stderr).toContain('"nativeFallback":false');
    expect(stdout + stderr).not.toContain("private-notification-token");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
