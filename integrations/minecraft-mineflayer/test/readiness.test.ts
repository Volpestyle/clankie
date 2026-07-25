import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectMinecraftLiveReadiness } from "../src/readiness.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function readyEnvironment() {
  const root = await mkdtemp(join(tmpdir(), "minecraft-readiness-"));
  roots.push(root);
  const javaHome = join(root, "jdk");
  await mkdir(join(javaHome, "bin"), { recursive: true });
  const java = join(javaHome, "bin", "java");
  await writeFile(java, "#!/bin/sh\necho 'openjdk version \"21.0.11\"' >&2\n");
  await chmod(java, 0o700);
  const paperJar = join(root, "paper.jar");
  const bytes = Buffer.from("test-only-paper-jar");
  await writeFile(paperJar, bytes);
  return {
    JAVA_HOME: javaHome,
    PAPER_JAR: paperJar,
    PAPER_JAR_SHA256: createHash("sha256").update(bytes).digest("hex"),
    MINECRAFT_EULA: "TRUE",
  };
}

describe("Minecraft live readiness", () => {
  it("requires Java 21, an exact Paper identity, and explicit EULA acknowledgement", async () => {
    const environment = await readyEnvironment();
    expect(inspectMinecraftLiveReadiness(environment)).toMatchObject({
      status: "ready",
      checks: {
        java21: true,
        paperJarPresent: true,
        paperJarIdentityVerified: true,
        eulaAcknowledged: true,
      },
      missingInputs: [],
    });
  });

  it("reports a mismatched Paper pin without exposing local paths", async () => {
    const environment = await readyEnvironment();
    const result = inspectMinecraftLiveReadiness({
      ...environment,
      PAPER_JAR_SHA256: "0".repeat(64),
      MINECRAFT_EULA: "FALSE",
    });
    const { javaExecutable: _java, paperJarPath: _paper, ...safeReceipt } = result;
    expect(safeReceipt).toMatchObject({
      status: "missing_inputs",
      checks: {
        paperJarIdentityVerified: false,
        eulaAcknowledged: false,
      },
      missingInputs: ["paper_jar_sha256", "minecraft_eula_acknowledgement"],
    });
    expect(JSON.stringify(safeReceipt)).not.toContain(environment.PAPER_JAR);
  });
});
