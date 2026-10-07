#!/usr/bin/env node
// The clankie-worker plugin's lifecycle hook (VUH-1458). A seat Clankie hired
// into a herdr pane reports each settled turn through `clankie seat-hook`; on
// a machine linked to his fleet (VUH-1527) it reports over that link instead.
// A session outside a pane has nothing to report here.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { authorization, hasLinks, readLink, seatRoute, SUMMARY_MAX, TEXT_MAX } from "./link.mjs";
import { codexToolCatalogReport } from "./codex-tool-catalog.mjs";
import { panePresence } from "./pane-presence.mjs";

const paneId = process.env.HERDR_PANE_ID?.trim();
if (!paneId) process.exit(0);
// Claude's prewarmed background processes may inherit a pane that has gone.
// They remain unclaimed; an unavailable native observation is not nonmembership.
if ((await panePresence(process.env.HERDR_SOCKET_PATH, paneId)) === false) process.exit(0);
if (hasLinks()) {
  // On a linked machine; a pane outside his fleets has nothing to report.
  const link = readLink();
  if (link) await reportOverLink(link, paneId);
  process.exit(0);
} else {
  const child = spawn("clankie", ["seat-hook"], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
  process.stdin.pipe(child.stdin);
  child.on("error", (error) => {
    process.stderr.write(`clankie-worker: ${error.message}\n`);
    process.exit(0);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function reportOverLink(link, pane) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 256 * 1024) process.exit(0);
  }
  let hook;
  try {
    hook = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const event = hook?.hook_event_name;
  if (!["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PreToolUse", "PermissionRequest", "Notification", "PostToolUse", "SessionEnd"].includes(event)) process.exit(0);
  if (typeof hook.session_id !== "string") process.exit(0);
  const lastMessage =
    typeof hook.last_assistant_message === "string" ? hook.last_assistant_message.trim() : "";
  const body = {
    schemaVersion: 1,
    event,
    sessionId: hook.session_id,
    ...(typeof hook.tool_name === "string" ? { toolName: hook.tool_name } : {}),
    ...(event === "PermissionRequest" ? { toolUseId: randomUUID() } : typeof hook.tool_use_id === "string" ? { toolUseId: hook.tool_use_id } : {}),
    ...(hook.tool_input && typeof hook.tool_input === "object" ? { toolInput: hook.tool_input } : {}),
    ...(typeof hook.notification_type === "string" ? { notificationType: hook.notification_type } : {}),
    ...(lastMessage ? { lastMessage: lastMessage.slice(0, TEXT_MAX) } : {}),
    ...(event === "StopFailure"
      ? { error: (typeof hook.error === "string" ? hook.error : "error").slice(0, SUMMARY_MAX) }
      : {}),
  };
  try {
    const response = await fetch(seatRoute(link, pane, "hook"), {
      method: "POST",
      headers: { ...authorization(link), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(event === "PermissionRequest" || event === "PreToolUse" ? 570_000 : 20_000),
    });
    if (response.ok && (event === "PermissionRequest" || event === "PreToolUse")) {
      const result = await response.json();
      if (result.hookOutput) await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result.hookOutput) + "\n", error => error ? reject(error) : resolve()));
    }
    if (response.ok && event === "UserPromptSubmit") {
      const result = await response.json();
      if (typeof result.additionalContext === "string" && result.additionalContext) {
        const output =
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: result.additionalContext,
            },
          }) + "\n";
        await new Promise((resolve, reject) =>
          process.stdout.write(output, (error) => (error ? reject(error) : resolve())),
        );
        if (Array.isArray(result.messageIds)) {
          const ack = await fetch(seatRoute(link, pane, "hook"), {
            method: "POST",
            headers: { ...authorization(link), "content-type": "application/json" },
            body: JSON.stringify({ ...body, deliveredMessageIds: result.messageIds }),
            signal: AbortSignal.timeout(5_000),
          });
          if (!ack.ok) process.stderr.write(`clankie-worker: hook receipt answered ${String(ack.status)}\n`);
        }
      }
    }
    if (!response.ok) process.stderr.write(`clankie-worker: seat hook answered ${String(response.status)}\n`);
    if (
      event === "SessionStart" &&
      process.argv.includes("--codex") &&
      !process.env.CLANKIE_CODEX_CATALOG_OBSERVED
    ) {
      const report = await codexToolCatalogReport({ sessionId: hook.session_id });
      const catalog = await fetch(seatRoute(link, pane, "tool-catalog"), {
        method: "POST",
        headers: { ...authorization(link), "content-type": "application/json" },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(5_000),
      });
      if (!catalog.ok) throw new Error(`Codex catalog report answered ${catalog.status}`);
      // Embedded Codex cannot inspect its original native catalog. Retain that
      // observation for doctor/roster, but it is not an actionable startup
      // warning, especially in an owner's hand-started interactive pane.
    }
  } catch (error) {
    process.stderr.write(`clankie-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(0);
}
