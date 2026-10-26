import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { managedService } from "../bin/services.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// What cloudflared adds to every request it forwards from activity.clankie.bot.
const TUNNEL = {
  host: "activity.clankie.bot",
  "cf-connecting-ip": "203.0.113.7",
  "cf-ray": "8f00000000000000-SJC",
  "x-forwarded-for": "203.0.113.7",
  "x-forwarded-proto": "https",
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

/** A raw WebSocket handshake: 101 means the server admitted the upgrade. */
function upgrade(url: string, headers: Record<string, string> = {}): Promise<"open" | "refused"> {
  return new Promise((done) => {
    const req = request(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        ...headers,
      },
    });
    req.once("upgrade", (_response, socket) => {
      socket.destroy();
      done("open");
    });
    req.once("response", () => done("refused"));
    req.once("error", () => done("refused"));
    req.end();
  });
}

it("the launcher-started activity serves the owner's loopback watch link and refuses the tunnel", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clankie-activity-viewer-")));
  const viewerPort = await freePort();
  const service = managedService("activity");
  const env = service.serviceEnv!({
    repoRoot: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CLANKIE_STATE: join(root, "state"),
      CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
      CLANKIE_ACTIVITY_PORT: String(viewerPort),
      CLANKIE_ACTIVITY_PRODUCER_PORT: String(await freePort()),
      NODE_ENV: "test",
    },
  });
  const launch = service.resolveProcess!({ env, repoRoot: REPO_ROOT });
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env ?? env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  try {
    await expect
      .poll(() => output, { timeout: 20_000, interval: 100 })
      .toContain("clankie activity producer listening");
    // Exactly the link `/activity` prints (apps/tui/src/index.ts activityWatchUrl).
    const watchUrl = `http://127.0.0.1:${String(viewerPort)}`;
    expect((await fetch(`${watchUrl}/`)).status).toBe(200);
    const config = (headers: Record<string, string> = {}) =>
      fetch(`${watchUrl}/.proxy/activity/config`, { headers }).then((response) => response.json());
    expect(await config()).toEqual({ mode: "local" });
    expect(await config(TUNNEL)).toEqual({ mode: "shares" });
    for (const path of ["/frames", "/.proxy/frames"]) {
      expect(await upgrade(`${watchUrl}${path}`, { origin: watchUrl })).toBe("open");
      expect(await upgrade(`${watchUrl}${path}`, TUNNEL)).toBe("refused");
    }
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
