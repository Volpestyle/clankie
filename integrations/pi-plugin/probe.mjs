// Hire-time capability probe for an installed native Pi release (VUH-2417).
// The service runs it with the selected native Node before admitting a hire:
//
//   node probe.mjs PACKAGE_ROOT
//
// It loads probe-extension.mjs through that package's own extension loader,
// binds the shipped worker runtime to a TUI-mode session from its SDK, and
// drives one brief through the surfaces a hire relies on: identity and session
// file layout, dialog blocking, custom-message receipt, follow-up turn,
// settlement and the MCP tool-error override. It runs offline in a throwaway
// profile against a local OpenAI-compatible endpoint, so no owner profile,
// credential or provider is touched. It prints one JSON line naming the first
// surface that did not behave as the worker relies on.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createPiWorkerRuntime } from "./worker-runtime.mjs";

const TOOL = "clankie_probe_tool";
const REPLY = "Clankie probe settled.";
let step = "load the installed Pi SDK";

const check = (ok, failure) => {
  if (!ok) throw new Error(failure);
};
const waitFor = async (read, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("not observed in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/** OpenAI Chat Completions stream: one tool call, then text once a tool result is present. */
function startEndpoint() {
  const chunk = (delta, finish) =>
    `data: ${JSON.stringify({
      id: "clankie-probe",
      object: "chat.completion.chunk",
      created: 0,
      model: "probe",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => (body += part));
    request.on("end", () => {
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      let messages = [];
      try {
        messages = JSON.parse(body).messages ?? [];
      } catch {
        /* A malformed request is answered as a first turn and fails the probe later. */
      }
      const answered = messages.some((message) => message.role === "tool");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        (answered
          ? chunk({ role: "assistant", content: REPLY }, null) + chunk({}, "stop")
          : chunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_clankie_probe",
                    type: "function",
                    function: { name: TOOL, arguments: "{}" },
                  },
                ],
              },
              null,
            ) + chunk({}, "tool_calls")) + "data: [DONE]\n\n",
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function probe(packageRoot, root) {
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  // The SDK resolves its default profile and session root from these, as the CLI does.
  Object.assign(process.env, {
    HOME: root,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  });
  const sdk = await import(pathToFileURL(join(packageRoot, "dist/index.js")).href);

  step = "serve the local probe model";
  const server = await startEndpoint();
  try {
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "clankie-probe": {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            api: "openai-completions",
            apiKey: "clankie-probe",
            models: [{ id: "probe", name: "Clankie probe", reasoning: false, input: ["text"] }],
          },
        },
      }),
    );

    step = "load the worker extension";
    let runtime;
    let ctx;
    let toolCalls = 0;
    const controller = {
      connected: () => true,
      authorize: async () => {},
      claim: async () => {},
      receipt: async () => {},
      close: () => {},
    };
    globalThis[Symbol.for("clankie.pi-worker.probe")] = (pi) => {
      runtime = createPiWorkerRuntime(pi, controller);
      pi.on("session_start", (_event, context) => {
        ctx = context;
        // The fleet consumer registers MCP tools after startup and activates them natively.
        pi.registerTool({
          name: TOOL,
          label: TOOL,
          description: "Clankie capability probe",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            toolCalls += 1;
            return { content: [{ type: "text", text: "refused" }], details: { mcp: { isError: true } } };
          },
        });
        pi.setActiveTools([...pi.getActiveTools(), TOOL]);
        check(
          pi.getAllTools().some((tool) => tool.name === TOOL),
          "registered tool not listed",
        );
      });
      pi.on("tool_result", (event) =>
        event.toolName === TOOL ? { isError: event.details?.mcp?.isError === true } : undefined,
      );
    };
    const settings = sdk.SettingsManager.create(cwd, agentDir);
    settings.setProjectTrusted(true);
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      additionalExtensionPaths: [join(import.meta.dirname, "probe-extension.mjs")],
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    check(runtime, "extension factory was not called");

    step = "select the probe model";
    const models = await sdk.ModelRuntime.create({
      modelsPath: join(agentDir, "models.json"),
      refreshOnCreate: false,
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => {
          throw new Error("The probe writes no credentials");
        },
        delete: async () => {
          throw new Error("The probe writes no credentials");
        },
      },
    });
    const model = models.getModel("clankie-probe", "probe");
    check(model, "models.json provider unavailable");

    step = "start a TUI-mode session";
    const { session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      settingsManager: settings,
      sessionManager: sdk.SessionManager.create(cwd),
      resourceLoader: loader,
      modelRuntime: models,
      model,
    });
    try {
      let answer;
      const ui = new Proxy(
        { confirm: () => new Promise((resolve) => (answer = resolve)) },
        {
          get: (target, key) => (key in target ? target[key] : key === "then" ? undefined : () => undefined),
        },
      );
      await session.bindExtensions({ mode: "tui", uiContext: ui });

      step = "initialize worker control";
      const identity = await runtime.initialize({ cwd });
      const sessions = join(agentDir, "sessions");
      check(
        dirname(identity.sessionFile) === identity.sessionDirectory &&
          !relative(sessions, identity.sessionFile).startsWith(".."),
        "session file outside the profile's sessions root",
      );
      check((await runtime.status()) === "idle", "fresh session is not idle");

      step = "block on an owner dialog";
      const dialog = ctx.ui.confirm("Clankie probe", "Capability probe dialog");
      await waitFor(async () => (await runtime.status()) === "blocked");
      answer(true);
      await dialog;
      await waitFor(async () => (await runtime.status()) === "idle");

      step = "receive a custom-message brief";
      const messageId = randomUUID();
      const sent = await runtime.send({
        messageId,
        text: "Clankie capability probe brief",
        deliverAs: "followUp",
        timeoutMs: 10_000,
      });
      check(sent.outcome === "accepted", `delivery ${sent.outcome}`);

      step = "settle the follow-up turn";
      const settled = await waitFor(async () => {
        const result = await runtime.settlement({ messageId });
        return result.state === "completed" ? result : undefined;
      });
      check(settled.ok && settled.text === REPLY, `settled as ${settled.stopReason}`);

      step = "mark an MCP refusal as a tool error";
      const result = ctx.sessionManager
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message?.role === "toolResult")?.message;
      check(toolCalls === 1 && result?.toolName === TOOL, "probe tool was not called once");
      check(result.isError === true, "tool_result isError override ignored");

      step = "persist the session header";
      const header = JSON.parse((await readFile(identity.sessionFile, "utf8")).split("\n")[0]);
      check(
        header.type === "session" &&
          header.version === 3 &&
          header.id === identity.sessionId &&
          header.cwd === cwd,
        "persisted header differs",
      );
    } finally {
      session.dispose();
    }
  } finally {
    server.close();
  }
}

const packageRoot = process.argv[2];
const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-pi-probe-")));
let outcome;
try {
  if (!packageRoot) throw new Error("package root required");
  await probe(packageRoot, root);
  outcome = { ok: true };
} catch (error) {
  outcome = { ok: false, reason: `${step}: ${String(error?.message ?? error).slice(0, 200)}` };
}
await rm(root, { recursive: true, force: true }).catch(() => {});
process.stdout.write(`${JSON.stringify(outcome)}\n`);
process.exit(0);
