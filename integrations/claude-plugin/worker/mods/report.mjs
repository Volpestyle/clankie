#!/usr/bin/env node
// Native mods have no Node imports. This short-lived helper reuses the same
// pane-scoped link selection and authentication as the worker bridge.
import { authorization, readLink, seatRoute } from "../bin/link.mjs";

// Remote reports need two fresh process observations, not just an HTTP hop.
const REQUEST_MS = 20_000;
const RECONNECT =
  "Run /mcp → reconnect clankie-worker. If it still fails, save this session and restart/resume Claude.";
const verdict = (reason, detail, remediation) => ({ status: "unverified", reason, detail, remediation });
const write = (result) => process.stdout.write(JSON.stringify(result) + "\n");

const pane = process.env.HERDR_PANE_ID?.trim();
const link = pane && readLink();
if (!link) {
  write({ status: "unlinked" });
} else {
  let validated = false;
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
    validated = true;
    const response = await fetch(seatRoute(link, pane, "tool-catalog"), {
      method: "POST",
      redirect: "error",
      headers: { ...authorization(link), "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) {
      // Never display arbitrary server bodies, paths, credentials or transport
      // exceptions in a pane. Preserve only known refusal codes and HTTP status.
      const body = await response.json().catch((error) => {
        if (
          ["TimeoutError", "AbortError"].includes(error?.name) ||
          ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(error?.cause?.code)
        )
          throw error;
        return undefined;
      });
      const codes = [
        "remote_pane_required",
        "remote_process_membership_required",
        "native_session_required",
        "local_pane_required",
      ];
      const code = codes.includes(body?.error) ? body.error : undefined;
      const observer =
        response.status === 503 &&
        ["remote_observation_timeout", "remote_observer_unavailable"].includes(body?.error)
          ? body.error
          : undefined;
      write(
        verdict(
          observer || (code ? `unbound:${code}` : `http:${response.status}`),
          observer
            ? `Clankie tool check ${observer === "remote_observation_timeout" ? "timed out during remote pane verification" : "could not reach the remote pane observer"} (HTTP 503, ${observer}).`
            : `Clankie tool check ${code ? "has no verified native pane binding" : "was refused"} (HTTP ${response.status}${code ? `, ${code}` : ""}).`,
          observer
            ? "Clankie will retry automatically. If it persists, ask Clankie to inspect the PC fleet link/SSH health; run clankie doctor --machine pc on his machine."
            : code
              ? `Clankie will retry the pane proof automatically. If it persists, ${RECONNECT}`
              : `Run clankie doctor in this pane to inspect its fleet link. ${RECONNECT}`,
        ),
      );
    } else {
      const result = await response.json();
      if (!["matched", "mismatch", "unverified"].includes(result?.status))
        throw new Error("Malformed Clankie catalog verdict");
      write(result);
    }
  } catch (error) {
    if (!validated) {
      process.stderr.write("clankie-worker: Invalid native Claude catalog report\n");
      process.exitCode = 1;
    } else {
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      const refused = error?.cause?.code === "ECONNREFUSED";
      const disconnected = ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(error?.cause?.code);
      write(
        verdict(
          timeout
            ? "timeout"
            : refused
              ? "connection_refused"
              : disconnected
                ? "link_disconnected"
                : "report_failed",
          timeout
            ? `Clankie tool check timed out after ${REQUEST_MS / 1000}s waiting for its fleet link and native pane proof.`
            : refused
              ? "Clankie tool check connection was refused by the fleet link."
              : disconnected
                ? "Clankie tool check lost its fleet link before a reply arrived."
                : "Clankie tool check could not complete its report through the fleet link.",
          timeout || refused || disconnected
            ? "Clankie will retry automatically. If it persists, ask Clankie to inspect the PC fleet link/SSH health; run clankie doctor --machine pc on his machine."
            : `Run clankie doctor in this pane to inspect its fleet link. ${RECONNECT}`,
        ),
      );
    }
  }
}
