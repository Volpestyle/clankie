import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  type WorkMediaEntry,
} from "@clankie/protocol";
import { Agent } from "undici";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { EvidenceStore } from "../src/evidence-store.ts";
import { downloadLinearUpload } from "../src/linear-import.ts";
import { LinearRequestBudget } from "../src/linear-request-budget.ts";
import { WorkMedia } from "../src/work-media.ts";
import type { WorkItemsService } from "../src/work-items.ts";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const BEARER = "linear-app-token";
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(256, 3)]);

/**
 * A stand-in for uploads.linear.app over real HTTP: it refuses a request without
 * the app bearer, answers one path with a redirect and streams one past the cap.
 */
async function fakeUploads() {
  const requests: { path: string; authorization?: string }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "https://uploads.linear.app").pathname;
    requests.push({
      path,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    });
    if (request.headers.authorization !== `Bearer ${BEARER}`) return response.writeHead(401).end();
    if (path === "/ws/shot.png")
      return response.writeHead(200, { "content-type": "application/octet-stream" }).end(png);
    if (path === "/ws/clip.mp4") return response.writeHead(200, { "content-type": "video/mp4" }).end(mp4);
    if (path === "/ws/page.png")
      return response.writeHead(200, { "content-type": "text/html" }).end("<script>alert(1)</script>");
    if (path === "/ws/logo.png")
      return response
        .writeHead(200, { "content-type": "image/svg+xml" })
        .end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    if (path === "/ws/notes.pdf")
      return response.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.7\n");
    if (path === "/ws/moved.png")
      return response.writeHead(302, { location: "https://elsewhere.example/shot.png" }).end();
    if (path === "/ws/huge.mp4") {
      response.writeHead(200, { "content-type": "video/mp4" });
      const chunk = Buffer.alloc(4 * 1024 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent <= 130 * 1024 * 1024) {
          sent += chunk.length;
          if (!response.write(chunk)) return void response.once("drain", pump);
        }
        response.end();
      };
      response.on("error", () => {});
      return pump();
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  cleanup.push(() => server.closeAllConnections());
  const { port } = server.address() as AddressInfo;
  // Every https://uploads.linear.app request reaches the fake over plain HTTP.
  const agent = new Agent({
    connect: (_options, callback) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => callback(null, socket));
      socket.once("error", (error) => callback(error, null));
    },
  });
  cleanup.push(() => agent.destroy());
  const viaFake: typeof fetch = (url, init) => fetch(url, { ...init, dispatcher: agent } as RequestInit);
  return { requests, fetch: viaFake };
}

async function harness(
  directory: string,
  uploads: Awaited<ReturnType<typeof fakeUploads>>,
  store: EvidenceStore,
) {
  const budget = new LinearRequestBudget();
  cleanup.push(() => budget.close());
  const credential = { type: "api" as const, key: BEARER };
  return new WorkMedia({
    evidence: store,
    directory,
    download: (url) =>
      downloadLinearUpload(url, {
        budget,
        access: async () => ({ bearer: BEARER, credential }),
        dispatch: () => {},
        priority: "interactive",
        fetch: uploads.fetch,
      }),
  });
}

it("serves a returned Linear upload once, as recorded evidence, and never fetches a link no item carried", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-media-"));
  const store = EvidenceStore.local(join(root, "evidence"));
  cleanup.push(() => store.close());
  const uploads = await fakeUploads();
  const media = await harness(join(root, "media"), uploads, store);
  const body = [
    "Recovery is back.",
    "![shot](https://uploads.linear.app/ws/shot.png?signature=first)",
    "![clip.mp4](https://uploads.linear.app/ws/clip.mp4?signature=first)",
    "![moved](https://uploads.linear.app/ws/moved.png)",
    "![huge.mp4](https://uploads.linear.app/ws/huge.mp4)",
  ].join("\n\n");
  const workItems = {
    handle: async (command: { action: string }) => {
      if (command.action !== "project-details") throw new Error(`unexpected ${command.action}`);
      return { repo: { id: "clankie" }, updates: [{ id: "update-1", body }] };
    },
  } as unknown as WorkItemsService;
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    evidenceStore: store,
    workItems,
    workMedia: media,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const dispatch = async (request: unknown) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    return response.json() as Promise<unknown>;
  };
  const resolve = async (urls: string[]) => {
    const result = OperatorConversationServiceResultSchema.parse(
      await dispatch({ op: "work_media", schemaVersion: 1, urls }),
    );
    if (result.op !== "work_media" || result.result.outcome !== "ready")
      throw new Error("work_media unavailable");
    return result.result.media;
  };
  const settle = async (urls: string[]) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const entries = await resolve(urls);
      if (entries.every((entry) => entry.state !== "pending")) return entries;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("media never settled");
  };

  // Before any item carried them, nothing is fetched: not a Linear upload, not an arbitrary URL.
  expect(
    await resolve(["https://uploads.linear.app/ws/shot.png?signature=first", "https://example.com/cat.png"]),
  ).toEqual([
    {
      url: "https://uploads.linear.app/ws/shot.png?signature=first",
      state: "failed",
      reason: "not_returned",
    },
    { url: "https://example.com/cat.png", state: "failed", reason: "not_returned" },
  ]);
  expect(uploads.requests).toEqual([]);

  await dispatch({ op: "work_project_details", schemaVersion: 1, repoId: "clankie" });
  // A later read signs the same upload differently; it is still the upload the item carried.
  const urls = [
    "https://uploads.linear.app/ws/shot.png?signature=second",
    "https://uploads.linear.app/ws/clip.mp4?signature=first",
    "https://uploads.linear.app/ws/moved.png",
    "https://uploads.linear.app/ws/huge.mp4",
    "https://uploads.linear.app/ws/never-returned.png",
  ];
  const first = await resolve(urls);
  expect(first.slice(0, 4).map((entry) => entry.state)).toEqual(["pending", "pending", "pending", "pending"]);
  expect(first[4]).toMatchObject({ state: "failed", reason: "not_returned" });
  const settled = await settle(urls);
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(settled).toEqual<WorkMediaEntry[]>([
    {
      url: urls[0]!,
      state: "ready",
      sha256: sha(png),
      // Served as octet-stream; the bytes say PNG.
      contentType: "image/png",
      kind: "image",
      size: png.length,
    },
    {
      url: urls[1]!,
      state: "ready",
      sha256: sha(mp4),
      contentType: "video/mp4",
      kind: "video",
      size: mp4.length,
    },
    // Redirects are never followed with the app bearer.
    { url: urls[2]!, state: "failed", reason: "unavailable" },
    { url: urls[3]!, state: "failed", reason: "too_large" },
    { url: urls[4]!, state: "failed", reason: "not_returned" },
  ]);
  // Every request carried the app bearer, each upload was read once, and never-returned stayed unread.
  expect(uploads.requests.every((request) => request.authorization === `Bearer ${BEARER}`)).toBe(true);
  expect(uploads.requests.map((request) => request.path).sort()).toEqual([
    "/ws/clip.mp4",
    "/ws/huge.mp4",
    "/ws/moved.png",
    "/ws/shot.png",
  ]);

  // The device reads the bytes through its existing evidence ops.
  expect(await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256: sha(png) })).toMatchObject({
    result: { outcome: "ready", available: true, contentType: "image/png", data: png.toString("base64") },
  });
  // A recorded evidence link resolves directly; an unrecorded one does not.
  expect(
    await resolve([`clankie://evidence/sha256/${sha(mp4)}`, `clankie://evidence/sha256/${"0".repeat(64)}`]),
  ).toEqual([
    {
      url: `clankie://evidence/sha256/${sha(mp4)}`,
      state: "ready",
      sha256: sha(mp4),
      contentType: "video/mp4",
      kind: "video",
      size: mp4.length,
    },
    { url: `clankie://evidence/sha256/${"0".repeat(64)}`, state: "failed", reason: "not_found" },
  ]);

  // After a restart the cache answers without another read or a fresh item.
  const restarted = await harness(join(root, "media"), uploads, store);
  const before = uploads.requests.length;
  expect(await restarted.resolve([urls[1]!])).toEqual([settled[1]]);
  expect(uploads.requests.length).toBe(before);
});

it("records an upload served as HTML or SVG as an opaque file, and reads past a damaged cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-media-types-"));
  const store = EvidenceStore.local(join(root, "evidence"));
  cleanup.push(() => store.close());
  const uploads = await fakeUploads();
  // A damaged cache file is only a cache: it starts empty instead of failing every read.
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "work-media.json"), "{not json");
  const media = await harness(join(root, "media"), uploads, store);
  const urls = [
    "https://uploads.linear.app/ws/page.png",
    "https://uploads.linear.app/ws/logo.png",
    "https://uploads.linear.app/ws/notes.pdf",
  ];
  media.observe({ body: urls.map((url) => `![upload](${url})`).join("\n") });
  let entries = await media.resolve(urls);
  for (let attempt = 0; attempt < 200 && entries.some((entry) => entry.state === "pending"); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    entries = await media.resolve(urls);
  }
  // Anyone in the workspace can upload, so only media types keep their name.
  expect(
    entries.map((entry) => (entry.state === "ready" ? [entry.contentType, entry.kind] : entry.state)),
  ).toEqual([
    ["application/octet-stream", "file"],
    ["application/octet-stream", "file"],
    ["application/pdf", "file"],
  ]);
  expect(JSON.parse(await readFile(join(root, "media", "work-media.json"), "utf8"))).toHaveProperty([
    urls[2]!,
  ]);
});

it("refuses an upload without the app bearer instead of serving it", async () => {
  const uploads = await fakeUploads();
  const budget = new LinearRequestBudget();
  cleanup.push(() => budget.close());
  await expect(
    downloadLinearUpload("https://uploads.linear.app/ws/shot.png", {
      budget,
      access: async () => ({ bearer: "wrong", credential: { type: "api", key: "wrong" } }),
      dispatch: () => {},
      fetch: uploads.fetch,
    }),
  ).rejects.toMatchObject({ reason: "unavailable", message: expect.stringContaining("HTTP 401") });
  // A host off the allowlist never receives the bearer.
  await expect(
    downloadLinearUpload("https://uploads.linear.app:8443/ws/shot.png", {
      budget,
      access: async () => ({ bearer: BEARER, credential: { type: "api", key: BEARER } }),
      dispatch: () => {},
      fetch: uploads.fetch,
    }),
  ).rejects.toThrow("Unsafe Linear upload URL");
  expect(uploads.requests).toEqual([{ path: "/ws/shot.png", authorization: "Bearer wrong" }]);
});
