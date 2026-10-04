import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { MinecraftSessionRef } from "@clankie/protocol";
import express from "express";
import type { Bot } from "mineflayer";
import { chromium, type Browser } from "playwright-core";
import { Server as SocketServer } from "socket.io";

const require = createRequire(import.meta.url);
type WorldView = {
  init(position: Bot["entity"]["position"]): Promise<void>;
  updatePosition(position: Bot["entity"]["position"]): void;
  listenToBot(bot: Bot): void;
  removeListenersFromBot(bot: Bot): void;
};
export type ViewerStatus = {
  session: MinecraftSessionRef;
  available: boolean;
  frameUrl?: string;
  width: number;
  height: number;
  maxBytes: number;
  contentType: "image/png";
};

/** Browser assets + WorldView only: the package root eagerly imports native canvas/gl. */
export class BrowserViewer {
  private readonly bot: Bot;
  private readonly session: MinecraftSessionRef;
  private server: Server | null = null;
  private io: SocketServer | null = null;
  private browser: Browser | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private frame: { png: Buffer; at: number } | null = null;
  private url: string | null = null;

  constructor(bot: Bot, session: MinecraftSessionRef) {
    this.bot = bot;
    this.session = session;
  }

  status(): ViewerStatus {
    return {
      session: structuredClone(this.session),
      available: this.frame !== null && !this.closed && Date.now() - this.frame.at <= 5000,
      ...(this.url && !this.closed ? { frameUrl: `${this.url}/frame.png` } : {}),
      width: 320,
      height: 180,
      maxBytes: 262144,
      contentType: "image/png",
    };
  }

  async start(): Promise<void> {
    const viewerRoot = dirname(require.resolve("prismarine-viewer/package.json"));
    const { WorldView: WorldViewClass } = require(join(viewerRoot, "viewer/lib/worldView.js")) as {
      WorldView: new (...args: unknown[]) => WorldView;
    };
    const app = express();
    app.get("/frame.png", (_request, response) => {
      if (!this.frame || this.closed || Date.now() - this.frame.at > 5000) {
        response.sendStatus(503);
        return;
      }
      response.set({
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "X-Minecraft-Session-Id": this.session.sessionId,
        "X-Minecraft-Connection-Generation": String(this.session.connectionGeneration),
        "X-Frame-Captured-At": String(this.frame.at),
        "X-Frame-Width": "320",
        "X-Frame-Height": "180",
      });
      response.send(this.frame.png);
    });
    app.use(express.static(join(viewerRoot, "public")));
    const server = createServer(app);
    const io = new SocketServer(server);
    this.server = server;
    this.io = io;
    io.on("connection", (socket) => {
      if (this.closed) {
        socket.disconnect();
        return;
      }
      socket.emit("version", this.bot.version);
      const worldView = new WorldViewClass(this.bot.world, 3, this.bot.entity.position, socket);
      // Viewer clicks are deliberately not wired back into bot motor controls.
      const position = () => {
        socket.emit("position", {
          pos: this.bot.entity.position,
          yaw: this.bot.entity.yaw,
          pitch: this.bot.entity.pitch,
          addMesh: false,
        });
        worldView.updatePosition(this.bot.entity.position);
      };
      this.bot.on("move", position);
      worldView.listenToBot(this.bot);
      void worldView.init(this.bot.entity.position);
      position();
      socket.on("disconnect", () => {
        this.bot.removeListener("move", position);
        worldView.removeListenersFromBot(this.bot);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    if (this.closed) {
      await this.close();
      return;
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Viewer has no loopback address");
    this.url = `http://127.0.0.1:${address.port}`;
    const configured = process.env.CLANKIE_MINECRAFT_CHROMIUM;
    const executablePath =
      configured ??
      [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
      ].find((path) => existsSync(path));
    const browser = await chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      headless: true,
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
    });
    this.browser = browser;
    if (this.closed) {
      await this.close();
      return;
    }
    const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
    await page.goto(this.url, { waitUntil: "networkidle", timeout: 30000 });
    await page.locator("canvas").waitFor({ timeout: 30000 });
    const capture = async () => {
      if (this.closed) return;
      try {
        const png = await page.screenshot({ type: "png", timeout: 5000 });
        if (!this.closed && png.byteLength <= 262144) this.frame = { png, at: Date.now() };
      } catch {
        /* A stale frame is rejected at ingress; next capture may recover. */
      }
      if (!this.closed)
        this.timer = setTimeout(() => {
          void capture();
        }, 500);
    };
    await capture();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.frame = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const browser = this.browser;
    this.browser = null;
    await browser?.close();
    const io = this.io;
    this.io = null;
    io?.disconnectSockets(true);
    io?.close();
    const server = this.server;
    this.server = null;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
