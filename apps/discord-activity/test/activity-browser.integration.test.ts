import { ActivityShareAudioSchema, ActivityShareFrameSchema } from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";
import { expect, it, vi } from "vitest";
import { createActivityShareClient } from "../../../packages/rendered-surface-client/src/activity-share-client.ts";
import { RenderedSurfaceHub } from "../src/frame-hub.ts";
import { createFrameProducerServer } from "../src/producer.ts";
import { createDiscordActivityServer } from "../src/server.ts";
import { ActivityShareRegistry } from "../src/share-registry.ts";

/** Real PNG encoding, so Chromium must decode bytes rather than a renderer stand-in. */
function png(red: number, green: number, blue: number, sequence = 0) {
  const chunk = (type: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(content.length + 8);
    result.writeUInt32BE(data.length);
    content.copy(result, 4);
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.from([0, red, green, blue, 255, red, green, blue, 255]);
  const data = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat([row, row]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return ActivityShareFrameSchema.parse({
    schemaVersion: 2,
    sequence,
    width: 2,
    height: 2,
    encoding: "png",
    data: data.toString("base64"),
    byteLength: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    capturedAt: new Date().toISOString(),
  });
}

/** Discord RPC provider boundary: the shipped SDK itself runs unchanged in the iframe. */
function discordHost(instanceId: string) {
  return `<!doctype html><html><body style="margin:0;height:100vh;background:#232a2e">
    <iframe id="viewer" title="Clankie Activity" style="width:100%;height:100%;border:0" allow="autoplay"
      src="/?frame_id=fixture-frame&instance_id=${instanceId}&platform=desktop&guild_id=forged-guild&channel_id=forged-channel"></iframe>
    <script>
      window.rpcCommands = [];
      addEventListener('message', (event) => {
        if (event.source !== document.getElementById('viewer').contentWindow || !Array.isArray(event.data)) return;
        const [op, payload] = event.data;
        const send = data => event.source.postMessage([1,data], location.origin);
        if (op === 0) send({cmd:'DISPATCH',evt:'READY',nonce:null,data:{v:1,config:{api_endpoint:'fixture',environment:'test'}}});
        if (op !== 1) return;
        window.rpcCommands.push(payload.cmd);
        let data;
        if (payload.cmd === 'AUTHORIZE') data = {code:'fixture-code-${instanceId}'};
        else if (payload.cmd === 'AUTHENTICATE') data = {access_token:payload.args.access_token,
          user:{id:'42',username:'fixture',discriminator:'0',public_flags:0},scopes:['identify'],
          expires:'2099-01-01T00:00:00.000Z',application:{id:'90001',name:'Clankie',description:'Fixture'}};
        else return;
        send({cmd:payload.cmd,evt:null,nonce:payload.nonce,data});
      });
    </script></body></html>`;
}

it.skipIf(process.env.ACTIVITY_BROWSER_INTEGRATION !== "1")(
  "official SDK admission renders isolated tenants with native PNG/audio, then switches, stops and revokes without anonymous fallback",
  async () => {
    const shares = new ActivityShareRegistry();
    const hub = new RenderedSurfaceHub();
    const producer = createFrameProducerServer({ hub, shares, token: "fixture-private-producer" });
    const activity = createDiscordActivityServer({
      hub,
      shares,
      viewerMode: { mode: "official", applicationId: "90001" },
    });
    const producerPort = await producer.listen(0),
      activityPort = await activity.listen(0);
    const client = createActivityShareClient({
      url: `http://127.0.0.1:${producerPort}`,
      token: "fixture-private-producer",
    });
    const a = await client.start({
      scope: {
        tenantId: "tenant-a",
        installationId: "install-a",
        guildId: "guild-a",
        channelId: "channel-a",
      },
      source: { kind: "game", id: "firered", title: "FireRed" },
      ttlMs: 60_000,
    });
    const b = await client.start({
      scope: {
        tenantId: "tenant-b",
        installationId: "install-b",
        guildId: "guild-b",
        channelId: "channel-b",
      },
      source: { kind: "image", id: "image-b", title: "Tenant B image" },
      ttlMs: 60_000,
    });
    const admissions: unknown[] = [];
    const grants = new Map<string, string>();
    const firstUseProofs = new Map<string, { expiresAt: number; used: boolean }>();
    const authority = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://localhost");
        if (path.pathname === "/discord-host") {
          response
            .writeHead(200, { "content-type": "text/html" })
            .end(discordHost(path.searchParams.get("instance") ?? "denied"));
          return;
        }
        if (path.pathname === "/.proxy/activity/admit") {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>;
          admissions.push(body);
          const session =
            body.instanceId === "instance-a" ? a : body.instanceId === "instance-b" ? b : undefined;
          if (
            Object.keys(body).sort().join() !== "code,instanceId" ||
            body.code !== `fixture-code-${body.instanceId}` ||
            !session
          ) {
            response.writeHead(403).end();
            return;
          }
          const grant = await client.grant(session);
          grants.set(session.shareId, grant.grant);
          firstUseProofs.set(session.shareId, { expiresAt: Date.now() + 2_000, used: false });
          response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(
            JSON.stringify({
              session,
              ...grant,
              // Ongoing viewing follows the session lifetime, independently of
              // the short-lived proof used only for the initial socket admission.
              expiresAt: session.expiresAt,
              mediaPath: `/.proxy/activity/shares/${session.shareId}/frames`,
              accessToken: "fixture-viewer-user-token",
            }),
          );
          return;
        }
        const upstream = await fetch(`http://127.0.0.1:${activityPort}${request.url ?? "/"}`);
        response
          .writeHead(upstream.status, Object.fromEntries(upstream.headers))
          .end(Buffer.from(await upstream.arrayBuffer()));
      })().catch(() => response.writeHead(500).end());
    });
    // Actual public admission/media server, not a WebSocket constructor substitute.
    authority.on("upgrade", (request, socket, head) => {
      const shareId = request.url?.match(/^\/\.proxy\/activity\/shares\/([^/]+)\/frames$/)?.[1];
      const proof = shareId === undefined ? undefined : firstUseProofs.get(shareId);
      if (!proof || proof.used || proof.expiresAt <= Date.now()) {
        socket.destroy();
        return;
      }
      proof.used = true;
      activity.server.emit("upgrade", request, socket, head);
    });
    await new Promise<void>((done) => authority.listen(0, "127.0.0.1", done));
    const address = authority.address();
    if (address === null || typeof address === "string") throw new Error("fixture_not_listening");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({
      executablePath:
        process.env.ACTIVITY_TEST_CHROMIUM ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
    });
    const sinks = [client.sink(a), client.sink(b)];
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      // Every HTTP request stays on loopback; any vendor network request is a test failure.
      const external: string[] = [];
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        if (url.startsWith(origin) || url.startsWith("data:")) await route.continue();
        else {
          external.push(url);
          await route.abort();
        }
      });
      const pageA = await context.newPage(),
        pageB = await context.newPage();
      const sockets: string[] = [];
      for (const page of [pageA, pageB]) page.on("websocket", (ws) => sockets.push(ws.url()));
      const webAudio = await context.newCDPSession(pageA);
      const nativeAudioContexts: unknown[] = [];
      const nativeAudioNodes: string[] = [];
      webAudio.on("WebAudio.contextCreated", (event) => nativeAudioContexts.push(event));
      webAudio.on("WebAudio.audioNodeCreated", (event) => nativeAudioNodes.push(event.node.nodeType));
      await webAudio.send("WebAudio.enable");
      await Promise.all([
        pageA.goto(`${origin}/discord-host?instance=instance-a`),
        pageB.goto(`${origin}/discord-host?instance=instance-b`),
      ]);
      const viewA = pageA.frameLocator("#viewer"),
        viewB = pageB.frameLocator("#viewer");
      await vi.waitFor(() => expect(shares.stats().map((s) => s.viewerCount)).toEqual([1, 1]), {
        timeout: 5000,
      });
      await vi.waitFor(() => expect(sinks.every((sink) => sink.connected)).toBe(true));
      sinks[0]!.publishFrame(png(240, 60, 60));
      sinks[1]!.publishFrame(png(60, 90, 240));
      const pixel = (view: typeof viewA) =>
        view
          .locator("#screen")
          .evaluate((canvas) =>
            Array.from((canvas as HTMLCanvasElement).getContext("2d")!.getImageData(0, 0, 1, 1).data),
          );
      await vi.waitFor(async () => {
        expect(await pixel(viewA)).toEqual([240, 60, 60, 255]);
        expect(await pixel(viewB)).toEqual([60, 90, 240, 255]);
      });
      expect(await viewA.locator("#source-caption").textContent()).toBe("game · FireRed");
      expect(await viewB.locator("#source-caption").textContent()).toBe("image · Tenant B image");
      expect(await viewA.locator("#lower-third").isVisible()).toBe(true);
      expect(await viewB.locator("#lower-third").isVisible()).toBe(false);
      sinks[0]!.publishOverlay({
        schemaVersion: 2,
        sequence: 0,
        objective: "Reach Cerulean City",
        intent: "Check the route",
        monologue: "Looking for the next path.",
        effect: null,
        updatedAt: new Date().toISOString(),
      });
      await vi.waitFor(async () =>
        expect(await viewA.locator("#objective").textContent()).toBe("Reach Cerulean City"),
      );
      const proofDeadline = Math.max(...Array.from(firstUseProofs.values(), (proof) => proof.expiresAt));
      await new Promise((done) => setTimeout(done, Math.max(0, proofDeadline - Date.now()) + 100));
      expect(Array.from(firstUseProofs.values()).every((proof) => proof.used)).toBe(true);
      expect(Date.now()).toBeGreaterThan(proofDeadline);
      expect(shares.stats().map((s) => s.viewerCount)).toEqual([1, 1]);
      sinks[0]!.publishFrame(png(230, 70, 70, 1));
      await vi.waitFor(async () => expect(await pixel(viewA)).toEqual([230, 70, 70, 255]));
      await viewA.locator("#sound-toggle").click();
      const pcm = Buffer.alloc(8_000 * 0.2 * 2 * 2);
      for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 32) * 3000), i);
      sinks[0]!.publishAudio(
        ActivityShareAudioSchema.parse({
          schemaVersion: 2,
          sequence: 0,
          encoding: "pcm_s16le",
          sampleRate: 8_000,
          channels: 2,
          frames: 1600,
          data: pcm.toString("base64"),
          byteLength: pcm.length,
          capturedAt: new Date().toISOString(),
        }),
      );
      await vi.waitFor(async () =>
        expect(await viewA.locator("#sound-toggle").textContent()).toBe("Sound on"),
      );
      expect(nativeAudioContexts).toHaveLength(1);
      expect(nativeAudioNodes).toContain("AudioBufferSource");
      const evidence = fileURLToPath(new URL("../../../.local/testing/activity-browser/", import.meta.url));
      await mkdir(evidence, { recursive: true });
      await pageA.screenshot({ path: `${evidence}/tenant-a-game-sound.png` });
      await pageB.screenshot({ path: `${evidence}/tenant-b-image.png` });
      const switched = await client.switchSource(a, {
        kind: "animation",
        id: "demo-a",
        title: "Tenant A demo",
      });
      sinks.push(client.sink(switched));
      await vi.waitFor(() => expect(sinks[2]!.connected).toBe(true));
      sinks[2]!.publishFrame(png(40, 210, 100));
      await vi.waitFor(async () => {
        expect(await pixel(viewA)).toEqual([40, 210, 100, 255]);
        expect(await pixel(viewB)).toEqual([60, 90, 240, 255]);
      });
      expect(await viewA.locator("#source-caption").textContent()).toBe("animation · Tenant A demo");
      expect(await viewA.locator("#lower-third").isVisible()).toBe(false);
      await pageA.screenshot({ path: `${evidence}/tenant-a-switched-animation.png` });
      for (const [name, width, height] of [
        ["phone", 390, 844],
        ["tablet", 1024, 768],
      ] as const) {
        await pageA.setViewportSize({ width, height });
        expect(await viewA.locator("#app").evaluate((app) => app.scrollWidth <= app.clientWidth)).toBe(true);
        const captionBounds = await viewA.locator("#source-caption").boundingBox();
        expect(captionBounds).not.toBeNull();
        expect(captionBounds!.x).toBeGreaterThanOrEqual(0);
        expect(captionBounds!.x + captionBounds!.width).toBeLessThanOrEqual(width);
        const soundBounds = await viewA.locator("#sound-toggle").boundingBox();
        expect(soundBounds).not.toBeNull();
        expect(soundBounds!.height).toBeGreaterThanOrEqual(44);
        expect(soundBounds!.x).toBeGreaterThanOrEqual(0);
        expect(soundBounds!.x + soundBounds!.width).toBeLessThanOrEqual(width);
        expect(soundBounds!.y + soundBounds!.height).toBeLessThanOrEqual(height);
        await pageA.screenshot({ path: `${evidence}/${name}-animation.png` });
      }
      await pageA.setViewportSize({ width: 1280, height: 800 });
      await client.stop(b);
      shares.revokeGrant(a.shareId, grants.get(a.shareId)!);
      await vi.waitFor(async () => {
        expect(await viewA.locator("#empty-title").textContent()).toBe("Session ended");
        expect(await viewB.locator("#empty-title").textContent()).toBe("Session ended");
        expect(await pixel(viewA)).toEqual([0, 0, 0, 0]);
        expect(await pixel(viewB)).toEqual([0, 0, 0, 0]);
        expect(await viewA.locator("#source-caption").textContent()).toBe("");
        expect(await viewB.locator("#source-caption").textContent()).toBe("");
        expect(await viewA.locator("#source-caption").isVisible()).toBe(false);
        expect(await viewB.locator("#source-caption").isVisible()).toBe(false);
      });
      await pageA.screenshot({ path: `${evidence}/revoked-terminal.png` });
      const denied = await context.newPage();
      const deniedSockets: string[] = [];
      denied.on("websocket", (socket) => deniedSockets.push(socket.url()));
      await denied.goto(`${origin}/discord-host?instance=denied`);
      await vi.waitFor(async () =>
        expect(await denied.frameLocator("#viewer").locator("#empty-title").textContent()).toBe(
          "Access unavailable",
        ),
      );
      const anonymous = await context.newPage();
      anonymous.on("websocket", (socket) => deniedSockets.push(socket.url()));
      await anonymous.goto(`${origin}/#share=${a.shareId}&grant=${grants.get(a.shareId)}`);
      await vi.waitFor(async () =>
        expect(await anonymous.locator("#empty-title").textContent()).toBe("Access unavailable"),
      );
      const unavailable = await context.newPage();
      unavailable.on("websocket", (socket) => deniedSockets.push(socket.url()));
      await unavailable.route("**/.proxy/activity/config", (route) =>
        route.fulfill({ status: 404, body: "not configured" }),
      );
      await unavailable.goto(origin);
      await vi.waitFor(async () =>
        expect(await unavailable.locator("#empty-title").textContent()).toBe("Access unavailable"),
      );
      await new Promise((done) => setTimeout(done, 1200));
      expect(deniedSockets).toEqual([]);
      expect(sockets).toHaveLength(2);
      expect(external).toEqual([]);
      expect(admissions).toHaveLength(3);
      expect(admissions).toEqual(
        expect.arrayContaining([
          { code: "fixture-code-instance-a", instanceId: "instance-a" },
          { code: "fixture-code-instance-b", instanceId: "instance-b" },
          { code: "fixture-code-denied", instanceId: "denied" },
        ]),
      );
      for (const page of [pageA, pageB])
        expect(
          await page.evaluate(() => (window as unknown as { rpcCommands: string[] }).rpcCommands),
        ).toEqual(["AUTHORIZE", "AUTHENTICATE"]);
    } finally {
      for (const sink of sinks) sink.close();
      await browser.close();
      await new Promise<void>((done) => authority.close(() => done()));
      await activity.close();
      await producer.close();
    }
  },
  30_000,
);
