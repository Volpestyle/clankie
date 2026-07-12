import { execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { platform, release, arch } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const directory = resolve(root, "artifacts", `support-${stamp}`);
await mkdir(directory, { recursive: true });

const commandVersion = async (command, args = ["--version"]) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5_000 });
    return `${stdout}${stderr}`.trim();
  } catch {
    return "unavailable";
  }
};

await writeFile(
  resolve(directory, "system.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      pnpm: await commandVersion("pnpm"),
      git: await commandVersion("git"),
      docker: await commandVersion("docker"),
      codex: await commandVersion("codex"),
      pi: await commandVersion("pi"),
      configuredEnvironmentKeys: Object.keys(process.env)
        .filter((key) => /^(CLANKIE_|OTEL_|SENTRY_|POSTHOG_|DISCORD_|OPENAI_|ANTHROPIC_)/.test(key))
        .sort(),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

for (const path of ["package.json", "pnpm-lock.yaml", ".node-version", ".env.example"]) {
  try {
    await cp(resolve(root, path), resolve(directory, basename(path)));
  } catch {
    // Optional diagnostic file.
  }
}

const doctrineSource = resolve(root, "doctrine/profiles");
const doctrineTarget = resolve(directory, "doctrine-profiles");
await cp(doctrineSource, doctrineTarget, { recursive: true });

const evalSource = resolve(root, "artifacts/evals/self-build");
try {
  await cp(evalSource, resolve(directory, "self-build-eval"), { recursive: true });
} catch {
  await writeFile(
    resolve(directory, "self-build-eval.txt"),
    "No self-build artifacts found. Run pnpm eval:self-build.\n",
  );
}

await writeFile(
  resolve(directory, "README.txt"),
  [
    "Redacted Clankie support bundle.",
    "Environment values, source code, prompts, terminal history, voice/audio, credentials, and raw provider transcripts are intentionally excluded.",
    "Review every file before sharing.",
    "",
  ].join("\n"),
  "utf8",
);

const archive = `${directory}.tar.gz`;
await execFileAsync("tar", ["-czf", archive, "-C", resolve(directory, ".."), basename(directory)]);
console.log(archive);
