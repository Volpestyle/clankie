import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { PINNED_PAPER_SHA256, pinnedPaperJarPath } from "./paper-build.ts";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const MinecraftLiveReadinessSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["ready", "missing_inputs"]),
    checks: z
      .object({
        java21: z.boolean(),
        paperJarPresent: z.boolean(),
        paperJarIdentityVerified: z.boolean(),
        eulaAcknowledged: z.boolean(),
      })
      .strict(),
    missingInputs: z.array(
      z.enum(["jdk_21", "paper_1_21_11_jar", "paper_jar_sha256", "minecraft_eula_acknowledgement"]),
    ),
    identities: z
      .object({
        paperJarSha256: Sha256Schema.optional(),
      })
      .strict(),
  })
  .strict();
export type MinecraftLiveReadiness = z.infer<typeof MinecraftLiveReadinessSchema>;

export function inspectMinecraftLiveReadiness(
  environment: NodeJS.ProcessEnv = process.env,
): MinecraftLiveReadiness & { javaExecutable?: string; paperJarPath?: string } {
  const javaExecutable = resolveJavaExecutable(environment);
  const java21 = javaExecutable !== undefined && isJava21(javaExecutable);
  const configuredPaperJarPath = environment["PAPER_JAR"]?.trim();
  const paperJarPath = configuredPaperJarPath ?? pinnedPaperJarPath(environment);
  const paperJarPresent = paperJarPath !== undefined && existsSync(paperJarPath);
  const expectedPaperSha256 =
    environment["PAPER_JAR_SHA256"]?.trim().toLowerCase() ??
    (configuredPaperJarPath === undefined ? PINNED_PAPER_SHA256 : undefined);
  const expectedHashValid =
    expectedPaperSha256 !== undefined && Sha256Schema.safeParse(expectedPaperSha256).success;
  const actualPaperSha256 = paperJarPresent ? sha256(readFileSync(paperJarPath)) : undefined;
  const paperJarIdentityVerified =
    paperJarPresent && expectedHashValid && actualPaperSha256 === expectedPaperSha256;
  const eulaAcknowledged = environment["MINECRAFT_EULA"] === "TRUE";
  const missingInputs: MinecraftLiveReadiness["missingInputs"] = [];
  if (!java21) missingInputs.push("jdk_21");
  if (!paperJarPresent) missingInputs.push("paper_1_21_11_jar");
  if (!expectedHashValid || (paperJarPresent && actualPaperSha256 !== expectedPaperSha256)) {
    missingInputs.push("paper_jar_sha256");
  }
  if (!eulaAcknowledged) missingInputs.push("minecraft_eula_acknowledgement");
  const result = MinecraftLiveReadinessSchema.parse({
    schemaVersion: 1,
    status: missingInputs.length === 0 ? "ready" : "missing_inputs",
    checks: {
      java21,
      paperJarPresent,
      paperJarIdentityVerified,
      eulaAcknowledged,
    },
    missingInputs,
    identities: {
      ...(paperJarIdentityVerified && actualPaperSha256 !== undefined
        ? { paperJarSha256: actualPaperSha256 }
        : {}),
    },
  });
  return {
    ...result,
    ...(java21 && javaExecutable !== undefined ? { javaExecutable } : {}),
    ...(paperJarPresent && paperJarPath !== undefined ? { paperJarPath } : {}),
  };
}

function resolveJavaExecutable(environment: NodeJS.ProcessEnv): string | undefined {
  const candidates = [
    environment["JAVA_HOME"] ? join(environment["JAVA_HOME"], "bin", "java") : undefined,
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java",
    "/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java",
    "/usr/bin/java",
  ].filter((candidate): candidate is string => candidate !== undefined);
  return candidates.find((candidate) => existsSync(candidate));
}

function isJava21(executable: string): boolean {
  const result = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const versionText = `${result.stdout}${result.stderr}`;
  return result.status === 0 && /\bversion "21(?:[."+-])/u.test(versionText);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
