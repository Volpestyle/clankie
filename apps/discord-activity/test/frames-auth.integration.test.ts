import { get } from "node:http";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { RenderedSurfaceHub } from "../src/frame-hub.ts";
import { createDiscordActivityServer, type DiscordActivityServerOptions } from "../src/server.ts";
import { ActivityShareRegistry } from "../src/share-registry.ts";

// What cloudflared adds to every request it forwards from activity.clankie.bot.
const TUNNEL = {
  host: "activity.clankie.bot",
  "cf-connecting-ip": "203.0.113.7",
  "cf-ray": "8f00000000000000-SJC",
  "x-forwarded-for": "203.0.113.7",
  "x-forwarded-proto": "https",
};

async function serve(options: Omit<DiscordActivityServerOptions, "hub"> = {}) {
  const hub = new RenderedSurfaceHub();
  const activity = createDiscordActivityServer({ hub, ...options });
  const port = await activity.listen(0);
  return { hub, activity, port };
}

/** "open" once the server completes the upgrade, "refused" when it drops the socket. */
function upgrade(port: number, path: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const outcome = new Promise<"open" | "refused">((done) => {
    socket.once("open", () => done("open"));
    socket.once("error", () => done("refused"));
  });
  return { socket, outcome };
}

// node:http, not fetch: fetch replaces a caller's Host header with its own.
const config = (port: number, headers: Record<string, string> = {}) =>
  new Promise<unknown>((done, reject) => {
    get(`http://127.0.0.1:${port}/.proxy/activity/config`, { headers }, async (response) => {
      let body = "";
      for await (const chunk of response) body += String(chunk);
      done(JSON.parse(body));
    }).once("error", reject);
  });

it("refuses an unauthenticated legacy upgrade by default, on both paths, local or tunnelled", async () => {
  const { hub, activity, port } = await serve({ shares: new ActivityShareRegistry() });
  try {
    expect(await config(port)).toEqual({ mode: "shares" });
    expect(await config(port, TUNNEL)).toEqual({ mode: "shares" });
    for (const path of ["/frames", "/.proxy/frames"]) {
      for (const headers of [{}, TUNNEL]) {
        const { socket, outcome } = upgrade(port, path, headers);
        expect(await outcome).toBe("refused");
        socket.terminate();
      }
    }
    expect(hub.viewerCount).toBe(0);
  } finally {
    await activity.close();
  }
});

it("admits a share-granted viewer through the tunnel with no dev mode", async () => {
  const shares = new ActivityShareRegistry();
  const { activity, port } = await serve({ shares });
  const { session } = shares.create(
    { tenantId: "t", installationId: "i", guildId: "g", channelId: "c" },
    { kind: "image", id: "image", title: "Image" },
  );
  const grant = shares.grant(session.shareId, session.generation);
  const { socket, outcome } = upgrade(port, `/.proxy/shares/${session.shareId}/frames`, TUNNEL);
  try {
    expect(await outcome).toBe("open");
    const first = new Promise<unknown>((done) =>
      socket.once("message", (data) => done(JSON.parse(String(data)))),
    );
    socket.send(JSON.stringify({ kind: "admit", grant: grant.grant }));
    expect(await first).toMatchObject({ kind: "session", session: { shareId: session.shareId } });
    expect(shares.stats()[0]?.viewerCount).toBe(1);
  } finally {
    socket.terminate();
    await activity.close();
  }
});

it("the explicit loopback dev mode opens legacy media only to direct loopback requests", async () => {
  const { hub, activity, port } = await serve({ viewerMode: { mode: "local" } });
  const sockets: WebSocket[] = [];
  try {
    expect(await config(port)).toEqual({ mode: "local" });
    expect(await config(port, TUNNEL)).toEqual({ mode: "shares" });
    for (const path of ["/frames", "/.proxy/frames"]) {
      const { socket, outcome } = upgrade(port, path, { origin: `http://localhost:${port}` });
      sockets.push(socket);
      expect(await outcome).toBe("open");
    }
    await vi.waitFor(() => expect(hub.viewerCount).toBe(2));
    for (const headers of [
      TUNNEL,
      { "cf-connecting-ip": "203.0.113.7" },
      { "x-forwarded-for": "203.0.113.7" },
      { "x-forwarded-port": "443" },
      { "x-forwarded-server": "proxy.example" },
      { "x-forwarded-prefix": "/public" },
      { "cf-ipcountry": "US" },
      { forwarded: "for=203.0.113.7" },
      { via: "1.1 proxy.example" },
      { host: "activity.clankie.bot" },
      { origin: "https://attacker.example" },
      { origin: "null" },
    ] as Record<string, string>[]) {
      expect(await config(port, headers), JSON.stringify(headers)).toEqual({ mode: "shares" });
      for (const path of ["/frames", "/.proxy/frames"]) {
        const { socket, outcome } = upgrade(port, path, headers);
        sockets.push(socket);
        expect(await outcome, `${path} ${JSON.stringify(headers)}`).toBe("refused");
      }
    }
    expect(hub.viewerCount).toBe(2);
  } finally {
    for (const socket of sockets) socket.terminate();
    await activity.close();
  }
});

it("caps anonymous pending admissions per tunnelled client and in total", async () => {
  const shares = new ActivityShareRegistry();
  const { activity, port } = await serve({ shares, maxPendingViewers: 6, maxPendingViewersPerClient: 2 });
  const path = "/.proxy/shares/e89ddcc6-7ddb-4a2f-83e2-649c6073f8cb/frames";
  const sockets: WebSocket[] = [];
  const attempt = async (client: string) => {
    const { socket, outcome } = upgrade(port, path, { ...TUNNEL, "cf-connecting-ip": client });
    sockets.push(socket);
    return outcome;
  };
  try {
    expect(await attempt("203.0.113.1")).toBe("open");
    expect(await attempt("203.0.113.1")).toBe("open");
    expect(await attempt("203.0.113.1")).toBe("refused");
    for (const client of ["203.0.113.2", "203.0.113.2", "203.0.113.3", "203.0.113.3"]) {
      expect(await attempt(client)).toBe("open");
    }
    expect(await attempt("203.0.113.4")).toBe("refused");
    // A denied admission frees its client's slot.
    const closed = new Promise<number>((done) => sockets[0]!.once("close", done));
    sockets[0]!.send(JSON.stringify({ kind: "admit", grant: "wrong" }));
    expect(await closed).toBe(4403);
    expect(await attempt("203.0.113.1")).toBe("open");
  } finally {
    for (const socket of sockets) socket.terminate();
    await activity.close();
  }
});
