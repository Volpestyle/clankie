import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const results = [];

function result(name, required, ok, detail, remediation) {
  results.push({ name, required, ok, detail, remediation });
}

const major = Number(process.versions.node.split(".")[0]);
result(
  "Node.js",
  true,
  major >= 24,
  process.version,
  "Install Node 24+; this repo pins 24 in .nvmrc/.node-version.",
);

for (const check of [
  ["pnpm", true, ["--version"], "Enable Corepack and install pnpm 11."],
  ["git", true, ["--version"], "Install Git."],
  ["docker", false, ["--version"], "Optional: install Docker for telemetry and sandbox experiments."],
  ["codex", false, ["--version"], "Optional: install/authenticate Codex CLI for App Server workers."],
  ["pi", false, ["--version"], "Optional: install @earendil-works/pi-coding-agent for Pi RPC workers."],
  ["herdr", false, ["--version"], "Optional: install Herdr as an external pane host."],
  ["xcodebuild", false, ["-version"], "Required only for iOS/macOS native shells."],
]) {
  const [command, required, args, remediation] = check;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5_000 });
    result(command, required, true, `${stdout}${stderr}`.trim().split("\n")[0] ?? "available", remediation);
  } catch {
    result(command, required, false, "not available", remediation);
  }
}

try {
  await access(resolve(root, "pnpm-lock.yaml"));
  result("lockfile", false, true, "pnpm-lock.yaml present", "Run pnpm install to create the lockfile.");
} catch {
  result(
    "lockfile",
    false,
    false,
    "pnpm-lock.yaml absent",
    "Run pnpm install before reproducible development.",
  );
}

const envExample = await readFile(resolve(root, ".env.example"), "utf8");
const configuredProviders = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DISCORD_BOT_TOKEN"].filter(
  (name) => process.env[name],
);
result(
  "provider credentials",
  false,
  configuredProviders.length > 0,
  configuredProviders.length
    ? `configured: ${configuredProviders.join(", ")}`
    : "none configured; offline lab remains available",
  "Copy only needed keys from .env.example into a local secret manager; never commit .env.",
);
if (!envExample.includes("CLANKIE_ANALYTICS_ENABLED=false")) {
  result(
    "analytics default",
    true,
    false,
    "missing disabled-by-default setting",
    "Restore analytics-disabled default in .env.example.",
  );
} else {
  result("analytics default", true, true, "disabled by default", "");
}

const width = Math.max(...results.map((entry) => entry.name.length));
for (const entry of results) {
  const marker = entry.ok ? "PASS" : entry.required ? "FAIL" : "SKIP";
  console.log(`${marker.padEnd(4)}  ${entry.name.padEnd(width)}  ${entry.detail}`);
  if (!entry.ok && entry.remediation) console.log(`      ${"".padEnd(width)}  ${entry.remediation}`);
}
const failed = results.filter((entry) => entry.required && !entry.ok);
if (failed.length) {
  console.error(`\nDoctor found ${failed.length} required issue(s).`);
  process.exitCode = 1;
} else {
  console.log("\nRequired development prerequisites are satisfied.");
}
