import { spawn } from "node:child_process";
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

const command = fileURLToPath(
  new URL("../../../integrations/claude-plugin/worker/bin/seat-hook.mjs", import.meta.url),
);
const ref: SeatRef = { harness: "claude", paneId: "command-worker", sessionId: "native-command-session" };

/** The installed command reads stdin, authenticates over HTTP and writes native hook JSON. */
async function commandRoundTrip(input: Record<string, unknown>, selections: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "claude-hook-command-"));
  const registry = new ClaudeHookQuestions(join(root, "used.json"));
  const token = "local-test-token-with-at-least-thirty-two-characters";
  const socket = join(root, "herdr.sock");
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
        const hookOutput = await registry.open(ref, hook, async (question) => announce({ question, hook }));
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
    expect(question.questions[0]?.options?.map((option) => option.label)).toEqual(["Allow", "Deny"]);
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
  expect(question.itemId).toBe("toolu_native_framework");
  expect(question.questions[0]?.options).toEqual(questions[0]!.options);
  expect(output).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Which framework?": "React" } },
    },
  });
});
