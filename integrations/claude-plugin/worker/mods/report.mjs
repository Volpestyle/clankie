#!/usr/bin/env node
// Native mods have no Node imports. This short-lived helper reuses the same
// pane-scoped link selection and authentication as the worker bridge.
import { authorization, readLink, seatRoute } from "../bin/link.mjs";

const pane = process.env.HERDR_PANE_ID?.trim();
const link = pane && readLink();
if (!link) {
  process.stdout.write(JSON.stringify({ status: "unlinked" }) + "\n");
} else {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Catalog report exceeds 1 MiB");
    }
    const report = JSON.parse(input);
    if (
      report?.schemaVersion !== 1 ||
      report.harness !== "claude" ||
      typeof report.sessionId !== "string" ||
      !report.sessionId ||
      report.sessionId.length > 256 ||
      !["worker", "operator"].includes(report.bridge) ||
      !Array.isArray(report.tools) ||
      report.tools.length > 4096 ||
      report.tools.some((name) => typeof name !== "string" || !name || name.length > 256) ||
      typeof report.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(report.checkedAt)) ||
      (report.conversationId !== undefined &&
        (report.bridge !== "operator" ||
          typeof report.conversationId !== "string" ||
          !report.conversationId ||
          report.conversationId.length > 256)) ||
      (report.error !== undefined && (typeof report.error !== "string" || report.error.length > 1024))
    )
      throw new Error("Invalid native Claude catalog report");
    const response = await fetch(seatRoute(link, pane, "tool-catalog"), {
      method: "POST",
      headers: { ...authorization(link), "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Clankie catalog report answered ${response.status}`);
    const result = await response.json();
    if (!["matched", "mismatch", "unverified"].includes(result?.status))
      throw new Error("Malformed Clankie catalog verdict");
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(`clankie-worker: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
