/** Attach as a viewer and report what actually arrives on the surface. */
import { WebSocket } from "ws";

const socket = new WebSocket(process.env["CLANKIE_ACTIVITY_VIEWER_URL"] ?? "ws://127.0.0.1:4320/frames");
let frames = 0;
let overlays = 0;
socket.on("message", (raw: Buffer) => {
  const message = JSON.parse(raw.toString()) as { kind: string; overlay?: Record<string, unknown> };
  if (message.kind === "frame") frames += 1;
  if (message.kind === "overlay" && message.overlay !== undefined) {
    overlays += 1;
    console.log(`OVERLAY: ${JSON.stringify(message.overlay)}`);
  }
});
const seconds = Number.parseInt(process.env["CLANKIE_VIEWER_SECONDS"] ?? "90", 10);
await new Promise((resolve) => setTimeout(resolve, seconds * 1_000));
console.log(`VIEWER frames=${String(frames)} overlays=${String(overlays)}`);
socket.close();
