import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installHerdrRelease, refreshOfficialHerdr } from "../src/herdr-release.ts";
import { prepareHerdrBinary } from "../src/herdr-binary.ts";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp("/tmp/ch-release-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const bytes = Buffer.from("official test binary");
const target = `${process.platform === "darwin" ? "macos" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
const manifest = {
  version: "1.2.3",
  assets: { [target]: `https://github.com/herdrdev/herdr/releases/download/v1.2.3/herdr-${target}` },
  sha256: { [target]: createHash("sha256").update(bytes).digest("hex") },
};

it("verifies official assets, caches checks, and retains the last verified release offline", async () => {
  const root = await temporary();
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("latest.json") ? Response.json(manifest) : new Response(bytes),
  );
  const path = await refreshOfficialHerdr(root, "/missing", fetchImpl);
  expect(await readFile(path)).toEqual(bytes);
  expect(await refreshOfficialHerdr(root, "/missing", fetchImpl)).toBe(path);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  await writeFile(join(root, "releases/current.json"), JSON.stringify({ manifest, checkedAt: 0 }));
  fetchImpl.mockRejectedValue(new Error("offline"));
  expect(await refreshOfficialHerdr(root, "/missing", fetchImpl)).toBe(path);
  await writeFile(path, "corrupted");
  await expect(refreshOfficialHerdr(root, "/missing", fetchImpl)).rejects.toThrow("offline");
});

it("rejects untrusted URLs and bad checksums without replacing an existing executable", async () => {
  const root = await temporary();
  const path = join(root, "herdr");
  await writeFile(path, "keep this");
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("wrong bytes"));
  await expect(
    installHerdrRelease(path, { ...manifest, assets: { [target]: "https://example.com/herdr" } }, fetchImpl),
  ).rejects.toThrow("official release URL");
  expect(fetchImpl).not.toHaveBeenCalled();
  await expect(installHerdrRelease(path, manifest, fetchImpl)).rejects.toThrow("checksum mismatch");
  expect(await readFile(path, "utf8")).toBe("keep this");
});

it("never replaces the matching executable of a live fleet", async () => {
  const root = await temporary();
  const answers = vi.fn(async (path: string) => path === join(root, "bin/herdr"));
  expect(await prepareHerdrBinary({ root, fallback: "/missing", listening: true, answers })).toBe(
    join(root, "bin/herdr"),
  );
  expect(answers).toHaveBeenCalledTimes(1);
});

it("retries a transient release download and names the URL when it gives up (#628)", async () => {
  const root = await temporary();
  const statuses: number[] = [];
  const server = createServer((_request, response) => {
    const status = statuses.shift() ?? 200;
    response.writeHead(status).end(status === 200 ? bytes : "busy");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The official URL is checked first; only the transport goes to this server.
  const local = vi.fn<typeof fetch>((_url, init) => fetch(`http://127.0.0.1:${port}/herdr`, init));
  try {
    statuses.push(503, 502);
    await installHerdrRelease(join(root, "herdr"), manifest, local, 3, 10);
    expect(await readFile(join(root, "herdr"))).toEqual(bytes);
    expect(local).toHaveBeenCalledTimes(3);

    local.mockClear();
    statuses.push(404);
    await expect(installHerdrRelease(join(root, "other"), manifest, local, 3, 10)).rejects.toThrow(
      `Herdr download of ${manifest.assets[target]} failed after 1 of 3 attempts: HTTP 404`,
    );
    expect(local).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  // A refused connection is transient: every attempt is spent, then the URL is named.
  await expect(installHerdrRelease(join(root, "closed"), manifest, local, 2, 10)).rejects.toThrow(
    `Herdr download of ${manifest.assets[target]} failed after 2 of 2 attempts`,
  );
  expect(local).toHaveBeenCalledTimes(3);
});

it("starts on the last verified release when herdr.dev doesn't answer in time (#609)", async () => {
  const root = await temporary();
  // A release verified on an earlier start, now due for its six-hourly check.
  const cached = join(root, "releases/1.2.3/herdr");
  await installHerdrRelease(cached, manifest, async () => new Response(bytes));
  await writeFile(join(root, "releases/current.json"), JSON.stringify({ manifest, checkedAt: 0 }));
  // The release host takes the request and never answers, as a congested network does.
  const held: import("node:http").ServerResponse[] = [];
  const server = createServer((_request, response) => void held.push(response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const slow = vi.fn<typeof fetch>((_url, init) => fetch(`http://127.0.0.1:${port}/latest.json`, init));
  try {
    const started = Date.now();
    const binary = await prepareHerdrBinary({
      root,
      fallback: "/missing",
      listening: false,
      answers: async () => false,
      releaseCheckMs: 300,
      fetch: slow,
    });
    // The start waited out its own deadline, not the 60-second request timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(binary).toBe(join(root, "bin/herdr"));
    expect(await readFile(binary)).toEqual(bytes);
  } finally {
    for (const response of held) response.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

it("retries a download whose body breaks off part way (#628)", async () => {
  const root = await temporary();
  let requests = 0;
  // The first response sends its headers and a few bytes, then the connection drops, as a
  // stalled CDN transfer does; the second is whole.
  const server = createServer((request, response) => {
    requests += 1;
    if (requests === 1) {
      response.writeHead(200, { "content-length": String(bytes.length) });
      response.write(bytes.subarray(0, 4));
      setTimeout(() => request.socket.destroy(), 50);
      return;
    }
    response.writeHead(200).end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const local = vi.fn<typeof fetch>((_url, init) => fetch(`http://127.0.0.1:${port}/herdr`, init));
  try {
    await installHerdrRelease(join(root, "herdr"), manifest, local, 3, 10);
    expect(await readFile(join(root, "herdr"))).toEqual(bytes);
    expect(requests).toBe(2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

it("lets a slow download that keeps delivering finish, and retries one that stalls (#712)", async () => {
  const root = await temporary();
  let requests = 0;
  // The first transfer drips a byte every 60 ms, well past the 300 ms stall
  // limit in all, but never silent that long. The second sends its headers and
  // goes quiet, as a stalled CDN edge does; the third is whole.
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-length": String(bytes.length) });
    if (requests === 2) return void response.write(bytes.subarray(0, 1));
    if (requests === 3) return void response.end(bytes);
    let sent = 0;
    const drip = setInterval(() => {
      response.write(bytes.subarray(sent, sent + 1));
      sent += 1;
      if (sent >= bytes.length) {
        clearInterval(drip);
        response.end();
      }
    }, 60);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const local = vi.fn<typeof fetch>((_url, init) => fetch(`http://127.0.0.1:${port}/herdr`, init));
  try {
    const timing = { stallMs: 300, totalMs: 30_000 };
    const started = Date.now();
    await installHerdrRelease(join(root, "slow"), manifest, local, 1, 10, undefined, timing);
    expect(await readFile(join(root, "slow"))).toEqual(bytes);
    expect(Date.now() - started).toBeGreaterThan(timing.stallMs);
    expect(requests).toBe(1);

    await installHerdrRelease(join(root, "stalled"), manifest, local, 2, 10, undefined, timing);
    expect(await readFile(join(root, "stalled"))).toEqual(bytes);
    expect(requests).toBe(3);

    // Spent attempts name the stall, not a bare abort.
    requests = 1;
    await expect(
      installHerdrRelease(join(root, "gone"), manifest, local, 1, 10, undefined, timing),
    ).rejects.toThrow("failed: no data for 300 ms");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
