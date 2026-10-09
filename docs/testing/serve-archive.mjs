#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path, { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testingRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testingRoot, "../..");
const mirrorRoot = path.join(repoRoot, ".local/evidence");
const viewerPath = path.join(testingRoot, "archive-viewer.html");
const imageExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const videoExtensions = new Set([".m4v", ".mov", ".mp4", ".webm"]);
const textExtensions = new Set([
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const mimeTypes = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".m4v": "video/x-m4v",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function within(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function kindFor(extension) {
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (textExtensions.has(extension)) return "text";
  return "binary";
}

function archiveFiles(root, directory = root) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...archiveFiles(root, file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

export function buildArchiveIndex(archiveDirectory) {
  const root = realpathSync(resolve(archiveDirectory));
  if (!statSync(root).isDirectory()) throw new Error(`not an archive directory: ${archiveDirectory}`);
  const files = archiveFiles(root)
    .map((file) => {
      const bytes = readFileSync(file);
      const extension = extname(file).toLowerCase();
      return {
        path: relative(root, file).split(path.sep).join(path.posix.sep),
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mime: mimeTypes[extension] ?? "application/octet-stream",
        kind: kindFor(extension),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const manifestFile of archiveFiles(root).filter((file) => path.basename(file) === "evidence.json")) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    for (const object of manifest.objects ?? []) {
      const target = resolve(dirname(manifestFile), object.path);
      if (!within(root, target) || files.some((file) => file.path === relative(root, target))) continue;
      const extension = extname(target).toLowerCase();
      files.push({
        path: relative(root, target).split(path.sep).join("/"),
        bytes: object.size,
        sha256: object.sha256,
        mime: mimeTypes[extension] ?? "application/octet-stream",
        kind: kindFor(extension),
        stored: true,
      });
    }
  }
  const readme = files.find((file) => file.path === "README.md");
  const heading = readme
    ? readFileSync(path.join(root, readme.path), "utf8").match(/^#\s+(.+)$/mu)?.[1]
    : null;
  return {
    root,
    index: {
      schemaVersion: 1,
      slug: path.basename(root),
      title: heading?.trim() || path.basename(root),
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      files,
    },
  };
}

function requestedArchiveFile(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://localhost").pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith("/files/") || pathname.includes("\0")) return null;
  const candidate = resolve(root, pathname.slice("/files/".length));
  if (!within(root, candidate)) return null;
  try {
    const mirrored = resolve(mirrorRoot, relative(repoRoot, candidate));
    const canonical = realpathSync(existsSync(candidate) ? candidate : mirrored);
    return (within(root, canonical) || within(mirrorRoot, canonical)) && statSync(canonical).isFile()
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function sendFile(response, file, method, contentType, headers = {}) {
  const info = statSync(file);
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Length": info.size,
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  if (method === "HEAD") response.end();
  else {
    const stream = createReadStream(file);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }
}

export function createArchiveServer(archiveDirectory) {
  const { root, index } = buildArchiveIndex(archiveDirectory);
  const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
  const server = createServer(async (request, response) => {
    // Loopback-only viewer: reject cross-origin requests before broker-backed reads.
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (
      request.headers.host !== expectedHost ||
      (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)
    ) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed\n");
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname.startsWith("/__evidence/")) {
      try {
        const { resolveOperatorCredential } =
          await import("../../packages/credential-broker/src/operator-credential.ts");
        const credential = await resolveOperatorCredential({ env: process.env });
        if (!credential) throw new Error("Evidence needs the operator credential. Run clankie doctor.");
        const host =
          process.env.CLANKIE_CONTROL_PLANE_URL ?? process.env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4310";
        const requested = new URL(request.url, "http://localhost");
        const suffix = pathname.slice("/__evidence/".length);
        if (suffix === "gaps") {
          const issue = requested.searchParams.get("issue");
          if (!issue) throw new Error("Issue required");
          const result = await fetch(
            new URL(`/v1/evidence/records?issue=${encodeURIComponent(issue)}`, host),
            { headers: { authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(30000) },
          );
          if (!result.ok) throw new Error(`Gaps: HTTP ${result.status}`);
          const { records } = await result.json();
          const gaps = [],
            seen = new Set();
          for (const record of records) {
            let folder = dirname(resolve(repoRoot, record.fileName));
            if (!within(testingRoot, folder)) continue;
            while (within(testingRoot, folder) && folder !== testingRoot) {
              const readme = path.join(folder, "README.md");
              if (existsSync(readme)) {
                if (!seen.has(readme)) {
                  seen.add(readme);
                  const canonical = realpathSync(readme);
                  if (!within(testingRoot, canonical)) break;
                  const text = readFileSync(canonical, "utf8");
                  const sections = text.split(/(?=^#{1,6}\s)/m);
                  for (const section of sections)
                    if (/^#{1,6}\s+.*(?:gaps|limitations|unproven)/i.test(section))
                      gaps.push({ source: relative(repoRoot, readme), text: section.trim() });
                }
                break;
              }
              folder = dirname(folder);
            }
          }
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ gaps }));
          return;
        }
        let upstream;
        if (suffix === "recent" || suffix === "records" || /^preview\/[0-9a-f]{64}$/.test(suffix)) {
          upstream = await fetch(new URL(`/v1/evidence/${suffix}${requested.search}`, host), {
            headers: { authorization: `Bearer ${credential.token}` },
            signal: AbortSignal.timeout(30000),
          });
        } else if (/^blob\/[0-9a-f]{64}$/.test(suffix)) {
          const hash = suffix.slice(5);
          const signed = await fetch(new URL("/v1/evidence/fetch", host), {
            method: "POST",
            headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
            body: JSON.stringify({ sha256: hash }),
            signal: AbortSignal.timeout(30000),
          });
          if (!signed.ok) throw new Error(`Fetch: HTTP ${signed.status}`);
          const link = await signed.json();
          upstream = await fetch(new URL(link.url, host), { signal: AbortSignal.timeout(30000) });
        } else {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(upstream.status, {
          "Content-Type": suffix.startsWith("blob/") ? "application/octet-stream" : "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
        if (request.method === "HEAD") {
          await upstream.body?.cancel();
          response.end();
        } else {
          const { Readable } = await import("node:stream");
          if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
          else response.end();
        }
      } catch (error) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (pathname === "/evidence-viewer.js") {
      sendFile(
        response,
        path.join(testingRoot, "evidence-viewer.js"),
        request.method,
        "text/javascript; charset=utf-8",
      );
      return;
    }
    if (pathname === "/" || pathname === "/archive-viewer.html") {
      sendFile(response, viewerPath, request.method, "text/html; charset=utf-8");
      return;
    }
    if (pathname === "/__archive.json") {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Length": indexBytes.byteLength,
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else response.end(indexBytes);
      return;
    }
    const file = requestedArchiveFile(root, request.url ?? "/");
    if (file === null) {
      let relativePath;
      try {
        relativePath = decodeURIComponent(pathname.slice("/files/".length));
      } catch {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Malformed path\n");
        return;
      }
      const stored = index.files.find((file) => file.path === relativePath && file.stored);
      if (stored) {
        const { runEvidenceCommand } = await import("../../apps/tui/src/command/evidence.ts");
        const result = await runEvidenceCommand(["fetch", root], {}).catch(() => ({ ok: false }));
        if (result.ok) {
          const found = requestedArchiveFile(root, request.url);
          if (found) {
            sendFile(response, found, request.method, stored.mime, {
              "Content-Security-Policy": "default-src 'none'; sandbox",
            });
            return;
          }
        }
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    const extension = extname(file).toLowerCase();
    const contentType = extension === ".html" ? "text/plain; charset=utf-8" : mimeTypes[extension];
    sendFile(response, file, request.method, contentType ?? "application/octet-stream", {
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
  });
  return { index, server };
}

async function rawRequest(port, requestPath, method = "GET") {
  const { request } = await import("node:http");
  return new Promise((resolveResponse, reject) => {
    const next = request({ host: "127.0.0.1", port, path: requestPath, method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolveResponse({
          body: Buffer.concat(chunks),
          headers: response.headers,
          status: response.statusCode,
        }),
      );
    });
    next.on("error", reject);
    next.end();
  });
}

export async function checkArchiveViewer(archiveDirectory) {
  const { index, server } = createArchiveServer(archiveDirectory);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const viewer = await rawRequest(address.port, "/");
    assert.equal(viewer.status, 200);
    assert.match(viewer.headers["content-type"], /^text\/html/u);
    assert.match(viewer.body.toString("utf8"), /Testing archive viewer/u);

    const archive = await rawRequest(address.port, "/__archive.json");
    assert.equal(archive.status, 200);
    assert.deepEqual(JSON.parse(archive.body.toString("utf8")), index);
    assert(index.files.some((file) => file.path === "README.md"));

    const readme = await rawRequest(address.port, "/files/README.md", "HEAD");
    assert.equal(readme.status, 200);
    assert.equal(readme.body.byteLength, 0);
    assert(Number(readme.headers["content-length"]) > 0);

    const image = index.files.find((file) => file.kind === "image");
    if (image) {
      const response = await rawRequest(address.port, `/files/${image.path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers["content-type"], /^image\//u);
    }

    assert.equal((await rawRequest(address.port, "/files/%2e%2e%2fpackage.json")).status, 404);
    const malformed = await rawRequest(address.port, "/files/%ZZ");
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.toString("utf8"), "Malformed path\n");
    assert.equal((await rawRequest(address.port, "/")).status, 200);
    assert.equal((await rawRequest(address.port, "/missing")).status, 404);
    assert.equal((await rawRequest(address.port, "/", "POST")).status, 405);
  } finally {
    await new Promise((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
  console.log(`archive viewer self-check passed: ${index.slug} (${index.files.length} files)`);
}

function latestArchive() {
  return readdirSync(testingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}-/u.test(entry.name))
    .map((entry) => path.join(testingRoot, entry.name))
    .sort()
    .at(-1);
}

export async function runArchiveViewerCli({ argv = process.argv.slice(2), defaultArchive } = {}) {
  const check = argv.includes("--check");
  const portArgument = argv.find((argument) => /^\d+$/u.test(argument));
  const archiveArgument = argv.find((argument) => !argument.startsWith("-") && !/^\d+$/u.test(argument));
  const archiveDirectory = archiveArgument ?? defaultArchive ?? latestArchive();
  if (!archiveDirectory) throw new Error("usage: serve-archive.mjs [archive-directory] [port] [--check]");
  if (check) {
    await checkArchiveViewer(archiveDirectory);
    return;
  }
  const { index, server } = createArchiveServer(archiveDirectory);
  const port = portArgument ? Number(portArgument) : 4173;
  server.listen(port, "127.0.0.1", () => {
    console.log(`${index.title}: http://127.0.0.1:${port}`);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runArchiveViewerCli();
}
