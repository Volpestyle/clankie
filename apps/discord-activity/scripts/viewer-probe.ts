/** Attach as a viewer and report what actually arrives on the surface. */
import { WebSocket } from "ws";

const socket = new WebSocket(process.env["CLANKIE_ACTIVITY_VIEWER_URL"] ?? "ws://127.0.0.1:4320/frames");
let frames = 0;
let overlays = 0;
const overlayLines: string[] = [];
socket.on("message", (raw: Buffer) => {
  const message = JSON.parse(raw.toString()) as { kind: string; overlay?: { lines: string[] } };
  if (message.kind === "frame") frames += 1;
  if (message.kind === "overlay" && message.overlay !== undefined) {
    overlays += 1;
    if (overlays === 1) console.log(`RAW OVERLAY: ${JSON.stringify(message.overlay)}`);
    overlayLines.length = 0;
    overlayLines.push(...(message.overlay.lines ?? []));
  }
});
const seconds = Number.parseInt(process.env["CLANKIE_VIEWER_SECONDS"] ?? "90", 10);
await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
console.log(`VIEWER frames=${String(frames)} overlays=${String(overlays)}`);
console.log(`VIEWER overlay:\n  ${overlayLines.join("\n  ")}`);
socket.close();
