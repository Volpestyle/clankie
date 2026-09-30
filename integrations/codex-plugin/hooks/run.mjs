#!/usr/bin/env node
import { spawnSync } from "node:child_process";
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
const run = (args, required = true) => {
  const result = spawnSync("clankie", args, { env, input, encoding: "utf8", timeout: 20000 });
  const ok = !result.error && result.status === 0;
  if (!ok) {
    process.stderr.write(result.stderr || String(result.error || `clankie ${args[0]} failed`));
    if (required) process.exitCode = 1;
  }
  return { ok, text: result.stdout || "" };
};
if (hook.hook_event_name === "SessionStart") {
  process.stdout.write(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../instructions/clankie.md"), "utf8"),
  );
  process.stdout.write(
    run(["prompt", "--lane", "operator", "--sections", "persona,reach,fleet,address,model"]).text,
  );
  run(["memory-card", "--lane", "operator", "--hook"]);
} else if (hook.hook_event_name === "UserPromptSubmit") {
  process.stdout.write(run(["memory-card", "--lane", "operator", "--hook"]).text);
}
// A display-upload failure must not discard context whose memory digest was
// already advanced, or block a native Stop. Retained entries retry next hook.
const synced = run(["seat-sync"], false).ok;
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
