// Run after building clankie-hosted:local. All accounts and model responses are synthetic.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const mode = process.argv[2];
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 240_000 });
if (mode === "--inside") {
  await inside();
} else if (mode === "--state") {
  const credentials = await readFile(process.env.CLANKIE_CREDENTIALS_FILE);
  assert.equal((await stat(process.env.CLANKIE_CREDENTIALS_FILE)).mode & 0o777, 0o600);
  assert.notEqual(process.getuid(), 0);
  console.log(
    JSON.stringify({
      credentialDigest: createHash("sha256").update(credentials).digest("hex"),
      workdir: JSON.parse(run("clankie", ["workdir", "status"])).workingDirectory,
      marker: await readFile("/workspace/hosted-proof.txt", "utf8").catch(() => null),
    }),
  );
} else {
  await outside();
}

async function inside() {
  const marker = `hosted-worker-${randomUUID()}`;
  let writesRequested = 0;
  let writesConfirmed = 0;
  let hireResult;
  let piTurns = 0;
  // The captain's brief is the only thing that may start the pi worker's turn.
  const brief = `PI_WORKER_BRIEF ${randomUUID()}: reply PI_WORKER_DONE`;
  // A real Claude binary executes one real Write tool. The canned model response
  // proves Linux process/tool transport, never model judgment or provider login.
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (req.url.endsWith("/chat/completions")) {
      // The captain hires a real pi worker, which calls back here as its own model.
      const hireOutcome = body.messages?.find(
        (message) => message.role === "tool" && message.tool_call_id === "hosted_hire",
      );
      if (hireOutcome) hireResult ??= JSON.stringify(hireOutcome.content);
      const piWorker = body.model === "pi-worker";
      if (piWorker && raw.includes(brief)) piTurns++;
      const hire = !piWorker && !hireOutcome && raw.includes("HIRE_PI_WORKER");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason) =>
        res.write(
          `data: ${JSON.stringify({
            id: "hosted-captain",
            object: "chat.completion.chunk",
            created: 1,
            model: "hosted-proof",
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      if (hire) {
        const args = JSON.stringify({
          harness: "pi",
          title: "pi proof",
          role: "builder",
          workingDirectory: "/workspace",
          brief,
        });
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "hosted_hire",
                type: "function",
                function: { name: "hire_agent", arguments: args },
              },
            ],
          },
          null,
        );
        chunk({}, "tool_calls");
        return res.end("data: [DONE]\n\n");
      }
      chunk({ role: "assistant", content: piWorker ? "PI_WORKER_DONE" : "HOSTED_CAPTAIN_OK" }, null);
      chunk({}, "stop");
      return res.end("data: [DONE]\n\n");
    }
    if (req.url.includes("count_tokens")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const canWrite = body.tools?.some((tool) => tool.name === "Write");
    const confirmed = body.messages?.some(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (block) => block.type === "tool_result" && block.tool_use_id === "hosted_write" && !block.is_error,
        ),
    );
    if (confirmed) writesConfirmed++;
    const write = canWrite && !confirmed;
    if (write) writesRequested++;
    const block = write
      ? {
          type: "tool_use",
          id: "hosted_write",
          name: "Write",
          input: { file_path: "/workspace/hosted-proof.txt", content: marker },
        }
      : { type: "text", text: "HOSTED_WORKER_OK" };
    const message = {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [block],
      stop_reason: write ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    };
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(message));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, fields) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    event("message_start", {
      message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
    });
    event("content_block_start", {
      index: 0,
      content_block: write ? { ...block, input: {} } : { type: "text", text: "" },
    });
    event("content_block_delta", {
      index: 0,
      delta: write
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
    });
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    event("message_stop", {});
    res.end();
  });
  await new Promise((done) => model.listen(18081, "127.0.0.1", done));
  const credentials = JSON.parse(await readFile(process.env.CLANKIE_CREDENTIALS_FILE, "utf8"));
  const headers = {
    authorization: `Bearer ${credentials.clankie_operator.key}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const rpc = async (method, params) => {
    const response = await fetch("http://127.0.0.1:4310/v1/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    if (response.headers.has("mcp-session-id"))
      headers["mcp-session-id"] = response.headers.get("mcp-session-id");
    const body = await response.json();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return body.result;
  };
  let hired;
  const call = async (name, args) => {
    const result = await rpc("tools/call", { name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const envelope = JSON.parse(result.content[0].text);
    assert.notEqual(envelope.ok, false, JSON.stringify(envelope));
    return envelope;
  };
  try {
    await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hosted-proof", version: "1" },
    });
    assert.equal((await fetch("http://127.0.0.1:4310/v1/mcp", { method: "POST" })).status, 401);
    for (const skill of ["lead"])
      assert.ok((await readFile(`/opt/clankie/.agents/skills/${skill}/SKILL.md`, "utf8")).length > 0);
    assert.ok(JSON.parse(await readFile("/opt/clankie/SBOM.cdx.json", "utf8")).components.length > 0);
    // Two whole bodies share this one Docker VM, so its memory floor is the
    // proof's, not a tenant's; hires still pass through the resource governor.
    run("clankie", ["fleet", "set", "--minimum-free-memory-mb", "1024"]);
    const tools = await rpc("tools/list", {});
    assert.ok(tools.tools.some((tool) => tool.name === "hire_agent"));
    assert.ok(!tools.tools.some((tool) => tool.name.startsWith("swarm_")));
    run("clankie", ["send", "--conversation", "global-default", "Prove the hosted captain can answer."]);
    let captainReply = false;
    const captainDeadline = Date.now() + 30_000;
    while (Date.now() < captainDeadline && !captainReply) {
      await sleep(250);
      const replay = JSON.parse(run("clankie", ["conversations", "show", "global-default"]));
      captainReply = replay.events?.some(
        (event) => event.type === "message" && event.role === "captain" && event.text === "HOSTED_CAPTAIN_OK",
      );
    }
    assert.ok(captainReply, "the compiled captain completes a synthetic model turn");
    hired = await call("hire_agent", {
      harness: "claude",
      title: "hosted-proof",
      role: "builder",
      workingDirectory: "/workspace",
      brief:
        "Write the authorized test marker to /workspace/hosted-proof.txt. Preserve other files. This isolated fixture supplies synthetic model responses. Report the result and checks.",
    });
    if (hired.outcome !== "spawned") {
      // The pane is the evidence: show what Claude was waiting on.
      const pane = /pane (\S+?);/u.exec(String(hired.detail))?.[1];
      if (pane) {
        try {
          console.error(run("clankie", ["herdr", "pane", "read", pane, "--source", "visible"]));
        } catch (error) {
          console.error(`Pane ${pane} unreadable: ${error}`);
        }
      }
    }
    assert.equal(hired.outcome, "spawned", JSON.stringify(hired));
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && writesConfirmed === 0) await sleep(250);
    if (writesConfirmed === 0) {
      // Show what the worker is waiting on, and whether it reached the model at all.
      console.error(JSON.stringify({ writesRequested, writesConfirmed }));
      const worker = JSON.parse(run("clankie", ["herdr", "agent", "list"])).result.agents.find(
        (agent) => agent.agent === "claude",
      );
      if (worker) console.error(run("clankie", ["herdr", "pane", "read", worker.pane_id, "--source", "visible"]));
    }
    assert.equal(await readFile("/workspace/hosted-proof.txt", "utf8"), marker);
    assert.ok(writesRequested > 0 && writesConfirmed > 0, "real Claude confirms its tool result");
    const pi = await provePiHire();
    await mkdir("/workspace/project");
    run("clankie", ["workdir", "set", "/workspace/project"]);
    console.log(
      JSON.stringify({
        passed: true,
        worker: hired.seat,
        runtime: run("claude", ["--version"]).trim(),
        pi,
        writesRequested,
        writesConfirmed,
        captainReply,
      }),
    );
  } finally {
    if (hired?.seat?.seatId) {
      await fetch("http://127.0.0.1:4310/operator/v1/dispatch", {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${credentials.clankie_captain.key}` },
        body: JSON.stringify({ op: "close_seat", schemaVersion: 1, seatId: hired.seat.seatId }),
      });
    }
    await fetch("http://127.0.0.1:4310/v1/mcp", { method: "DELETE", headers });
    model.closeAllConnections();
    await new Promise((done) => model.close(done));
  }

  // hire_agent(pi) needs the pi CLI and Herdr's pi integration, whose session
  // report is the seat's durable identity; then the captain's brief, and nothing
  // else, starts the worker's turn (VUH-1373).
  // Briefed pi hires stay opt-in (CLANKIE_PI_NATIVE_ENABLED, packages/agent-hosts)
  // until live acceptance: the captain's hire must refuse honestly, starting no seat.
  async function provePiHire() {
    // Queue it: the Claude worker's report may still hold an autonomous wake
    // turn, and a steer into that turn cannot hire.
    run("clankie", [
      "send",
      "--conversation",
      "global-default",
      "--delivery",
      "queue",
      "HIRE_PI_WORKER for the hosted proof.",
    ]);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && hireResult === undefined) await sleep(250);
    assert.match(hireResult ?? "no hire_agent result", /harness_unavailable/, hireResult);
    assert.match(hireResult, /no seat was started and no terminal input was sent/, hireResult);
    const agents = JSON.parse(run("clankie", ["herdr", "agent", "list"])).result.agents;
    assert.ok(!agents.some((agent) => agent.agent === "pi"), JSON.stringify(agents));
    assert.equal(piTurns, 0, "no pi turn ran");
    return { version: run("pi", ["--version"]).trim(), briefs: "opt-in" };
  }
}

async function outside() {
  const root = resolve(import.meta.dirname, "..");
  const scratch = await mkdtemp(join(tmpdir(), "clankie-hosted-"));
  const id = `clankie-proof-${randomUUID().slice(0, 8)}`;
  const projects = [id, `${id}-other`];
  const override = join(scratch, "compose.json");
  await writeFile(
    override,
    JSON.stringify({
      services: {
        captain: {
          healthcheck: { interval: "1s" },
          environment: {
            ANTHROPIC_API_KEY: "synthetic-hosted-proof",
            ANTHROPIC_BASE_URL: "http://127.0.0.1:18081",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
        },
      },
    }),
  );
  const compose = (project, args) =>
    run("docker", [
      "compose",
      "-p",
      project,
      "-f",
      join(root, "infra/hosted/compose.yaml"),
      "-f",
      override,
      ...args,
    ]);
  const copyProof = (project) => {
    const container = compose(project, ["ps", "-q", "captain"]).trim();
    run("docker", ["cp", import.meta.filename, `${container}:/tmp/hosted-proof.mjs`]);
  };
  const state = (project) =>
    JSON.parse(compose(project, ["exec", "-T", "captain", "node", "/tmp/hosted-proof.mjs", "--state"]));
  try {
    compose(id, [
      "run",
      "--rm",
      "--no-deps",
      "captain",
      "clankie",
      "model",
      "add-local",
      "--id",
      "hosted-proof",
      "--base-url",
      "http://127.0.0.1:18081",
      "--models",
      "hosted-proof",
      "--set",
    ]);
    for (const project of projects) {
      compose(project, ["up", "-d", "--wait", "--wait-timeout", "120"]);
      copyProof(project);
    }
    const other = state(projects[1]);
    console.log(compose(id, ["exec", "-T", "captain", "node", "/tmp/hosted-proof.mjs", "--inside"]).trim());
    const before = state(id);
    assert.notEqual(
      before.credentialDigest,
      other.credentialDigest,
      "owners have different broker credentials",
    );
    assert.equal(other.marker, null);
    assert.equal(other.workdir, "/workspace");
    compose(id, ["up", "-d", "--force-recreate", "--wait", "--wait-timeout", "120"]);
    copyProof(id);
    assert.deepEqual(state(id), before, "credentials, settings and work survive container replacement");
    assert.equal(before.workdir, "/workspace/project");
    console.log(
      "Hosted smoke passed: non-root captain turn + relay, real Claude/Herdr worker with synthetic model, native hire, honest refusal of a briefed pi hire while pi briefs are opt-in, owner isolation, persistent credentials/settings/workspace.",
    );
  } catch (error) {
    for (const project of projects) process.stderr.write(compose(project, ["logs", "--tail", "30"]));
    throw error;
  } finally {
    for (const project of projects) compose(project, ["down", "--volumes", "--remove-orphans"]);
    await rm(scratch, { recursive: true, force: true });
  }
}
