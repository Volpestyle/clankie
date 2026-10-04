#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Installing the plugin never claims an operator conversation. Only the
// launcher grants this invocation a private binding file.
const bindingPath = process.env.CLANKIE_CODEX_SEAT_BINDING;
if (!bindingPath) process.exit(0);
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > 65536) throw new Error("Seat hook input exceeds 64 KiB");
}
const hook = JSON.parse(input);
if (hook.agent_id || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(hook.session_id ?? ""))
  process.exit(0);
const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
const writeBinding = () => {
  const temporary = `${bindingPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(binding), { mode: 0o600 });
  renameSync(temporary, bindingPath);
};
if (!binding.sessionId && hook.hook_event_name === "SessionStart") {
  binding.sessionId = hook.session_id;
  writeBinding();
}
if (binding.sessionId !== hook.session_id) process.exit(0);
const env = { ...process.env, CLANKIE_SEAT_SESSION_ID: binding.sessionId, CLANKIE_SEAT_HARNESS: "codex" };
// Each clankie command is a cold start, so independent ones run side by side
// rather than adding up on every prompt.
const run = (args, required = true) =>
  new Promise((resolve) => {
    const child = spawn("clankie", args, { env, timeout: 20000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    let settled = false;
    const settle = (ok, error) => {
      if (settled) return;
      settled = true;
      if (!ok) {
        process.stderr.write(stderr || String(error || `clankie ${args[0]} failed`));
        if (required) process.exitCode = 1;
      }
      resolve({ ok, text: stdout });
    };
    child.on("error", (error) => settle(false, error));
    child.on("close", (code) => settle(code === 0));
  });
// A display-upload failure must not discard context whose memory digest was
// already advanced, or block a native Stop. Retained entries retry next hook.
const sync = run(["seat-sync"], false);
if (hook.hook_event_name === "SessionStart") {
  const [prompt] = await Promise.all([
    run(["prompt", "--lane", "operator", "--sections", "persona,reach,fleet,address,model"]),
    run(["memory-card", "--lane", "operator", "--hook"]),
  ]);
  process.stdout.write(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../instructions/clankie.md"), "utf8"),
  );
  process.stdout.write(prompt.text);
} else if (hook.hook_event_name === "UserPromptSubmit") {
  process.stdout.write((await run(["memory-card", "--lane", "operator", "--hook"])).text);
}
const synced = (await sync).ok;
if (hook.hook_event_name === "SessionStart") {
  binding.contextReady = !process.exitCode;
  binding.ready = binding.contextReady && synced;
  writeBinding();
} else if (
  hook.hook_event_name === "UserPromptSubmit" &&
  binding.contextReady &&
  synced &&
  !process.exitCode
) {
  // The launcher binds the outbox only after Codex actually ran trusted hooks.
  // Installing a plugin or starting the TUI alone must not take wakes from Pi.
  binding.ready = true;
  writeBinding();
}
