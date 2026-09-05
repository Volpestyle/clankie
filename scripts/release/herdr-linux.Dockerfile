# Runtime integration proof; this image is not the hosted Clankie service image.
FROM node:24.20.0-bookworm AS node
FROM rust:1.96.1-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --input-type=module -e '\
  import {execFileSync} from "node:child_process"; \
  import {writeFileSync} from "node:fs"; \
  import {createHash} from "node:crypto"; \
  const index = await (await fetch("https://ziglang.org/download/index.json")).json(); \
  const target = process.arch === "arm64" ? "aarch64-linux" : "x86_64-linux"; \
  const artifact = index["0.15.2"][target]; \
  const archive = Buffer.from(await (await fetch(artifact.tarball)).arrayBuffer()); \
  if (createHash("sha256").update(archive).digest("hex") !== artifact.shasum) throw new Error("Zig checksum mismatch"); \
  writeFileSync("/tmp/zig.tar.xz", archive); \
  execFileSync("mkdir", ["-p", "/opt/zig"]); \
  execFileSync("tar", ["-xf", "/tmp/zig.tar.xz", "--strip-components=1", "-C", "/opt/zig"]);'
ENV PATH="/opt/zig:${PATH}"
WORKDIR /clankie
COPY scripts/build-herdr.mjs scripts/build-herdr.mjs
COPY scripts/release/herdr.json scripts/release/herdr.json
RUN node scripts/build-herdr.mjs
COPY apps/clankie/src/herdr-runtime.ts apps/clankie/src/herdr-runtime.ts
COPY scripts/smoke-herdr.mjs scripts/smoke-herdr.mjs
CMD ["node", "scripts/smoke-herdr.mjs"]
