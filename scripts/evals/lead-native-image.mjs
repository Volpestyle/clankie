/** Explicit future runtime build; never invoked by imports, checks or campaign defaults. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { dockerTransportIdentity } from "./lead-containment.mjs";
const builds = new WeakMap();
const NATIVE_SOURCE = Object.freeze({
  codex: "008bbd5884122dc95aaece19ecfe0fc6a59dcf36",
  herdr: "4812c9054cfce3e294a300c60d30d78d2a447d38",
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function sourceArchive(root, kind) {
  if (realpathSync(root) !== root) throw Error("Noncanonical native source checkout");
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      env: { PATH: process.env.PATH, HOME: "/nonexistent" },
      maxBuffer: 256 * 1024 * 1024,
    });
  const expected =
    kind === "codex" ? "git@github.com:openai/codex.git" : "git@github.com:Volpestyle/clankie-herdr.git";
  if (
    git("remote", "get-url", "origin").toString().trim() !== expected ||
    git("rev-parse", NATIVE_SOURCE[kind]).toString().trim() !== NATIVE_SOURCE[kind]
  )
    throw Error("Pinned native source origin unavailable");
  // Archive the exact object, not a dirty worktree, ignored auth or local build outputs.
  return git("archive", "--format=tar", NATIVE_SOURCE[kind]);
}

export async function buildNativeImage({ command, output, codexSource, herdrSource, rustImage, nodeImage }) {
  const daemon = dockerTransportIdentity(command);
  if (
    !/^rust:1\.96\.1-bookworm@sha256:[a-f0-9]{64}$/u.test(rustImage) ||
    !/^node:24\.20\.0-bookworm@sha256:[a-f0-9]{64}$/u.test(nodeImage)
  )
    throw Error("Explicit digest-pinned official Rust/Node build bases required");
  mkdirSync(output, { mode: 0o700 });
  if (realpathSync(output) !== output || lstatSync(output).uid !== process.getuid())
    throw Error("Unowned native build directory");
  const codex = sourceArchive(codexSource, "codex"),
    herdr = sourceArchive(herdrSource, "herdr");
  writeFileSync(join(output, "codex.tar"), codex, { flag: "wx", mode: 0o400 });
  writeFileSync(join(output, "herdr.tar"), herdr, { flag: "wx", mode: 0o400 });
  const dockerfile = `FROM ${rustImage} AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libcap-dev libasound2-dev cmake ninja-build && rm -rf /var/lib/apt/lists/*
ADD codex.tar /src/codex/
ADD herdr.tar /src/herdr/
WORKDIR /src/codex/codex-rs
RUN cargo build --release --locked --bin bwrap
RUN CODEX_BWRAP_SHA256=$(sha256sum target/release/bwrap | cut -d' ' -f1) cargo build --release --locked --bin codex
WORKDIR /src/herdr
RUN cargo build --release --locked --bin herdr
FROM ${nodeImage}
RUN apt-get update && apt-get install -y --no-install-recommends libcap2 libasound2 python3 git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/codex/codex-rs/target/release/codex /opt/codex/bin/codex
COPY --from=build /src/codex/codex-rs/target/release/bwrap /opt/codex/bin/bwrap
COPY --from=build /src/herdr/target/release/herdr /usr/local/bin/herdr
COPY --from=build /src/codex/LICENSE /usr/share/licenses/codex/LICENSE
COPY --from=build /src/herdr/LICENSE /usr/share/licenses/herdr/LICENSE
ENV PATH=/opt/codex/bin:/usr/local/bin:/usr/bin:/bin
RUN test ! -e /etc/codex
WORKDIR /eval
`;
  writeFileSync(join(output, "Dockerfile"), dockerfile, { flag: "wx", mode: 0o400 });
  const iid = join(output, "image-id");
  await command(["build", "--iidfile", iid, "--file", join(output, "Dockerfile"), output], {
    timeout: 7_200_000,
  });
  const stat = lstatSync(iid);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size > 256)
    throw Error("Invalid native build result");
  const image = readFileSync(iid, "utf8").trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw Error("Native build has no immutable image ID");
  const result = Object.freeze({
    image,
    source: NATIVE_SOURCE,
    sources: { codex: hash(codex), herdr: hash(herdr) },
    dockerfile: hash(dockerfile),
    rustImage,
    nodeImage,
  });
  builds.set(result, { ...structuredClone(result), command, daemon });
  return result;
}

export function requireNativeBuild(build, command) {
  const record = builds.get(build);
  if (
    !record ||
    record.command !== command ||
    JSON.stringify(record.daemon) !== JSON.stringify(dockerTransportIdentity(command))
  )
    throw Error("Native image requires controller-origin source build on this exact daemon");
  return structuredClone({ ...record, command: undefined });
}
