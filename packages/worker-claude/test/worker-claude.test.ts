import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerRunContext } from "@clankie/worker-sdk";
import { runWorkerAdapterContract } from "../../worker-sdk/test/worker-contract.ts";
import {
  ClaudeWorkerAdapter,
  claudeCandidateToolHook,
  completedClaudeToolEvents,
  renderClaudePrompt,
  type ClaudeQuery,
} from "../src/index.ts";

describe("completedClaudeToolEvents", () => {
  it("normalizes completed command and file tools without raw arguments or results", () => {
    const pending = new Map();
    expect(
      completedClaudeToolEvents(
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "echo SECRET" } },
              {
                type: "tool_use",
                id: "write-1",
                name: "Write",
                input: { file_path: "src/secret.ts", content: "SECRET" },
              },
            ],
          },
        },
        pending,
      ),
    ).toEqual([]);
    const completed = completedClaudeToolEvents(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "bash-1", content: "SECRET", is_error: false },
            { type: "tool_result", tool_use_id: "write-1", content: "SECRET", is_error: false },
          ],
        },
      },
      pending,
    );
    expect(completed.map((event) => event.type)).toEqual([
      "worker.command.completed",
      "worker.file_change.completed",
    ]);
    expect(JSON.stringify(completed)).not.toContain("SECRET");
    expect(JSON.stringify(completed)).not.toContain("src/secret.ts");
  });
});

describe("renderClaudePrompt", () => {
  it("defines the lead-worker boundary", () => {
    const prompt = renderClaudePrompt({
      missionId: "m",
      workerRunId: "run-claude-prompt",
      workspacePath: "/tmp",
      profileHash: "p",
      attempt: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
      task: {
        id: "review",
        title: "Review change",
        objective: "Find defects",
        kind: "review",
        role: "reviewer",
        dependsOn: [],
        executionClass: "runner_headless",
        risk: "medium",
        writeScope: [],
        successCriteria: ["find regressions"],
        evidenceRequirements: ["Report findings with file locations."],
        maxAttempts: 1,
        metadata: {},
      },
    });
    expect(prompt).toContain("lead owns intent");
    expect(prompt).toContain("Role: reviewer");
    expect(prompt).toContain("Report findings with file locations.");
    expect(prompt).toContain("read-only");
  });
});

describe("ClaudeWorkerAdapter environment allowlist", () => {
  const poisonKey = "CLANKIE_VUH819_POISON";

  afterEach(() => {
    delete process.env[poisonKey];
  });

  it("forwards only the allowlisted environment so a poisoned runner env var never reaches the worker", async () => {
    process.env[poisonKey] = "leak-me-if-you-can";
    const allowlisted = {
      PATH: "/toolchain/bin",
      HOME: "/home/worker",
      ANTHROPIC_API_KEY: "sk-allowlisted",
    };
    let forwardedEnv: NodeJS.ProcessEnv | undefined;
    let envForwarded = false;
    const query: ClaudeQuery = (input) => {
      envForwarded = "env" in input.options;
      forwardedEnv = input.options.env as NodeJS.ProcessEnv | undefined;
      return recordedStream();
    };
    const adapter = new ClaudeWorkerAdapter({ query, environment: allowlisted });

    const result = await adapter.run(context());

    expect(result.status).toBe("succeeded");
    expect(envForwarded).toBe(true);
    expect(forwardedEnv).toEqual(allowlisted);
    // The poison lives on process.env at run time; the SDK subprocess env is
    // replaced by options.env, so it cannot reach the worker.
    expect(forwardedEnv).not.toHaveProperty(poisonKey);
    expect(Object.values(forwardedEnv ?? {})).not.toContain("leak-me-if-you-can");
  });

  it("omits env when no environment is supplied, preserving the SDK default inheritance", async () => {
    let envForwarded = true;
    const query: ClaudeQuery = (input) => {
      envForwarded = "env" in input.options;
      return recordedStream();
    };
    const adapter = new ClaudeWorkerAdapter({ query });

    const result = await adapter.run(context());

    expect(result.status).toBe("succeeded");
    expect(envForwarded).toBe(false);
  });
});

function recordedStream(): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: "claude-env-session" };
    yield { type: "result", result: "done", is_error: false };
  })();
}

function context(): WorkerRunContext {
  return {
    missionId: "mission-env",
    workerRunId: "run-claude-env",
    workspacePath: "/tmp/worker-env",
    profileHash: "profile-env",
    attempt: 1,
    signal: new AbortController().signal,
    emit: () => undefined,
    task: {
      id: "implement",
      title: "Implement",
      objective: "Write code",
      kind: "implementation",
      role: "implementer",
      dependsOn: [],
      executionClass: "runner_visible",
      risk: "low",
      writeScope: ["src/**"],
      successCriteria: ["done"],
      evidenceRequirements: ["diff attached"],
      maxAttempts: 1,
      metadata: {},
    },
  };
}

describe("Claude sandbox boundary", () => {
  it("preserves SDK auth while denying credential state and write tools to a verifier", async () => {
    let options: Record<string, unknown> | undefined;
    const query: ClaudeQuery = (input) => {
      options = input.options;
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "claude-verifier-session" };
        yield { type: "result", result: "verified", is_error: false };
      })();
    };
    const adapter = new ClaudeWorkerAdapter({
      query,
      environment: {
        PATH: "/bin",
        HOME: "/runner/synthetic-tool-home",
        ANTHROPIC_API_KEY: "SECRET_SDK_AUTH",
      },
      credentialFiles: [
        "/runner/.claude",
        "/runner/.codex",
        "/runner/.clankie",
        "/host/.ssh",
        "/host/.aws",
        "/host/.config",
      ],
      requireCredentialBoundary: true,
    });
    await adapter.run(verificationContext());
    expect(options?.env).toMatchObject({ ANTHROPIC_API_KEY: "SECRET_SDK_AUTH" });
    expect(options?.tools).not.toContain("Edit");
    expect(options?.tools).not.toContain("Write");
    expect(options?.tools).not.toContain("Bash");
    expect(options?.disallowedTools).toEqual(["Edit", "Write", "Bash"]);
    expect(options?.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      credentials: {
        envVars: expect.arrayContaining([{ name: "ANTHROPIC_API_KEY", mode: "deny" }]),
        files: expect.arrayContaining([{ path: "/runner/.codex", mode: "deny" }]),
      },
      filesystem: {
        denyRead: expect.arrayContaining(["/host/.ssh", "/host/.aws", "/host/.config"]),
        denyWrite: expect.arrayContaining(["/tmp/worker-contract"]),
      },
    });
    expect(options?.settings).toMatchObject({
      disableBundledSkills: true,
      permissions: { disableBypassPermissionsMode: "disable" },
    });
  });

  it("denies arbitrary outside and symlink-escaped reads before the tool can run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clankie-claude-candidate-"));
    const outside = await mkdtemp(join(tmpdir(), "clankie-claude-private-"));
    const sentinel = join(outside, "arbitrary-private-file");
    await writeFile(sentinel, "SECRET_SENTINEL_never_read", { mode: 0o600 });
    const hook = claudeCandidateToolHook(workspace);
    const invoke = (toolName: string, toolInput: Record<string, unknown>, id: string) =>
      hook(
        {
          hook_event_name: "PreToolUse",
          tool_name: toolName,
          tool_input: toolInput,
          tool_use_id: id,
          session_id: "session",
          transcript_path: "",
          cwd: workspace,
        },
        id,
        { signal: new AbortController().signal },
      );
    const denied = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: sentinel },
        tool_use_id: "outside-read",
        session_id: "session",
        transcript_path: "",
        cwd: workspace,
      },
      "outside-read",
      { signal: new AbortController().signal },
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(JSON.stringify(denied)).not.toContain("SECRET_SENTINEL_never_read");

    const escapedPath = join(workspace, "escaped-private-file");
    await symlink(sentinel, escapedPath);
    const escaped = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: escapedPath },
        tool_use_id: "escaped-read",
        session_id: "session",
        transcript_path: "",
        cwd: workspace,
      },
      "escaped-read",
      { signal: new AbortController().signal },
    );
    expect(escaped).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });

    const escapedDirectory = join(workspace, "escaped-directory");
    await symlink(outside, escapedDirectory);
    for (const [toolName, toolInput] of [
      ["Glob", { pattern: "../../.ssh/*" }],
      ["Glob", { pattern: "{src,../.ssh}/**/*" }],
      ["Glob", { pattern: "@(src|../.ssh)/**/*" }],
      ["Glob", { pattern: "{src,test}/**/*" }],
      ["Glob", { pattern: "@(src|test)/**/*" }],
      ["Glob", { pattern: "~user/.ssh/*" }],
      ["Glob", { pattern: "src\\..\\.ssh\\*" }],
      ["Glob", { pattern: `${outside}/*` }],
      ["Glob", { pattern: "*", path: escapedDirectory }],
      ["Grep", { pattern: "private", path: "../" }],
      ["Grep", { pattern: "private", glob: "../../.ssh/*" }],
      ["Grep", { pattern: "private", glob: "{src,../.ssh}/**/*" }],
      ["Grep", { pattern: "private", glob: "{src,test}/**/*" }],
      ["Grep", { pattern: "private", glob: "@(src|test)/**/*" }],
      ["Grep", { pattern: "private", glob: "~/.ssh/*" }],
      ["Grep", { pattern: "private", path: escapedDirectory }],
    ] as const) {
      await expect(invoke(toolName, toolInput, `${toolName}-traversal`)).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    }

    const allowedFile = join(workspace, "candidate.ts");
    await writeFile(allowedFile, "export {};\n");
    const allowed = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: allowedFile },
        tool_use_id: "candidate-read",
        session_id: "session",
        transcript_path: "",
        cwd: workspace,
      },
      "candidate-read",
      { signal: new AbortController().signal },
    );
    expect(allowed).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(invoke("Glob", { pattern: "src/**/*.ts" }, "candidate-glob")).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    await expect(
      invoke("Grep", { pattern: "../ is ordinary source text", glob: "**/*.ts" }, "candidate-grep"),
    ).resolves.toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  });
});

runWorkerAdapterContract(
  "Claude Agent SDK",
  () => {
    let assigned = false;
    const query: ClaudeQuery = (input) => {
      const sandbox = input.options.sandbox as Record<string, unknown>;
      const credentials = sandbox.credentials as Record<string, unknown>;
      assigned =
        input.prompt.includes("task-contract") &&
        input.options.cwd === "/tmp/worker-contract" &&
        sandbox.enabled === true &&
        sandbox.failIfUnavailable === true &&
        sandbox.allowUnsandboxedCommands === false &&
        Array.isArray(credentials.envVars);
      return (async function* () {
        yield { type: "system", subtype: "init", session_id: "claude-session" };
        yield {
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test" } }],
          },
          session_id: "claude-session",
        };
        const canUseTool = input.options.canUseTool;
        if (typeof canUseTool !== "function") throw new Error("Missing Claude permission callback");
        await canUseTool(
          "Bash",
          { command: "pnpm test" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
            requestId: "permission-1",
            title: "Allow the worker to run the scoped test?",
          },
        );
        yield {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "all tests pass" }],
          },
          session_id: "claude-session",
        };
        yield { type: "result", result: "Claude contract complete.", is_error: false };
      })();
    };
    return {
      adapter: new ClaudeWorkerAdapter({
        query,
        canUseTool: async () => ({ behavior: "allow" }),
      }),
      assigned: () => assigned,
      nativeSessionId: "claude-session",
      statusSource: "claude.agent_sdk",
    };
  },
  () => {
    let startedRun: (() => void) | undefined;
    let forwarded = false;
    const started = new Promise<void>((resolvePromise) => {
      startedRun = resolvePromise;
    });
    const query: ClaudeQuery = (input) =>
      (async function* () {
        yield { type: "system", subtype: "init", session_id: "claude-cancel-session" };
        const controller = input.options.abortController;
        if (!(controller instanceof AbortController)) throw new Error("Missing Claude abort controller");
        await new Promise<never>((_, reject) => {
          const abort = () => {
            forwarded = true;
            reject(new Error("Claude transport aborted"));
          };
          if (controller.signal.aborted) abort();
          else controller.signal.addEventListener("abort", abort, { once: true });
          startedRun?.();
        });
      })();
    return {
      adapter: new ClaudeWorkerAdapter({ query }),
      nativeSessionId: "claude-cancel-session",
      started,
      cancellationForwarded: () => forwarded,
    };
  },
);

function verificationContext() {
  return {
    missionId: "mission-verifier",
    workerRunId: "run-verifier",
    workspacePath: "/tmp/worker-contract",
    profileHash: "profile-verifier",
    attempt: 1,
    signal: new AbortController().signal,
    emit: () => undefined,
    task: {
      id: "verify",
      title: "Verify",
      objective: "Verify the candidate",
      kind: "verification" as const,
      role: "verifier" as const,
      dependsOn: ["implementation"],
      executionClass: "runner_headless" as const,
      risk: "low" as const,
      writeScope: [],
      successCriteria: ["checks pass"],
      evidenceRequirements: ["runner evidence"],
      maxAttempts: 1,
      metadata: {},
    },
  };
}
