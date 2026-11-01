#!/usr/bin/env node
// Invoked only by the original-native mod. The parent's kernel identity is
// checked against socket admission, never accepted from the report's stdin.
import { authorization, readLink, seatIdentity, seatRoute } from "../bin/link.mjs";
// Its Herdr pane, or the desktop-app terminal Clankie started it in (ADR 0319).
const pane = seatIdentity().pane;
const link = pane && readLink();
if (link) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 32768) throw Error("Activity report too large");
    }
    const report = JSON.parse(input);
    const response = await fetch(seatRoute(link, pane, "hook"), {
      method: "POST",
      redirect: "error",
      headers: { ...authorization(link), "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        event: "NativeActivity",
        sessionId: report.sessionId,
        activity: { ...report.activity, producerPid: process.ppid },
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) process.exitCode = 1;
  } catch {
    // Failure only expires this fact. It never affects native work or grants
    // permission to reconnect/restart a harness, bridge or service.
    process.exitCode = 1;
  }
}
