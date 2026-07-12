import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const EXPECTED_PI_VERSION = "0.80.6";
const probeEnvironment = pickEnvironment(process.env, [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

const reports = await Promise.all([checkCodex(), checkClaude(), checkPi()]);
for (const report of reports) {
  process.stdout.write(
    `${JSON.stringify({ provider: report.provider, ready: report.issues.length === 0, issues: report.issues })}\n`,
  );
}
if (reports.some((report) => report.issues.length > 0)) process.exitCode = 1;

async function checkCodex() {
  const issues = [];
  const command = process.env.CLANKIE_CODEX_EXECUTABLE?.trim() || "codex";
  required(process.env.CLANKIE_CODEX_MODEL, "model_not_configured", issues);
  const codexHome = required(process.env.CODEX_HOME, "auth_home_not_configured", issues);
  const codexEnvironment = { ...probeEnvironment, ...(codexHome ? { CODEX_HOME: codexHome } : {}) };
  await executable(command, "executable_unavailable", issues, codexEnvironment);
  if (codexHome) {
    const authFile = await validateCodexAuthFile(codexHome);
    if (authFile.status === "unavailable") {
      issues.push(issue("auth_file_unavailable", "Configure a private file-backed CODEX_HOME/auth.json."));
    } else if (authFile.status === "invalid") {
      issues.push(
        issue("auth_file_invalid", "Re-authenticate Codex to replace the malformed auth document."),
      );
    } else {
      const authenticated = await commandSucceeds(
        command,
        ["-c", 'cli_auth_credentials_store="file"', "login", "status"],
        codexEnvironment,
      ).then(
        () => true,
        () => false,
      );
      if (!authenticated) {
        issues.push(issue("auth_unavailable", "Codex CLI reports no authenticated account."));
      } else {
        const afterProbe = await validateCodexAuthFile(codexHome);
        if (afterProbe.status !== "valid" || afterProbe.identity !== authFile.identity) {
          issues.push(
            issue("auth_file_unavailable", "Codex auth changed during the bounded readiness probe."),
          );
        }
      }
    }
  }
  return { provider: "codex", issues };
}

async function validateCodexAuthFile(codexHome) {
  const path = join(codexHome, "auth.json");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > 1024 * 1024 ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      return { status: "unavailable" };
    }
    const content = await handle.readFile({ encoding: "utf8" });
    const value = JSON.parse(content);
    return validCodexAuthDocument(value)
      ? {
          status: "valid",
          identity: `${String(metadata.dev)}:${String(metadata.ino)}:${createHash("sha256").update(content).digest("hex")}`,
        }
      : { status: "invalid" };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(error.code)
    ) {
      return { status: "unavailable" };
    }
    return { status: "invalid" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validCodexAuthDocument(value) {
  if (!isRecord(value)) return false;
  if (!optionalString(value.OPENAI_API_KEY) || !optionalString(value.personal_access_token)) return false;
  if (value.last_refresh !== undefined && value.last_refresh !== null) {
    if (typeof value.last_refresh !== "string" || Number.isNaN(Date.parse(value.last_refresh))) return false;
  }
  if (value.tokens !== undefined && value.tokens !== null && !validCodexTokens(value.tokens, false))
    return false;
  if (
    value.agent_identity !== undefined &&
    value.agent_identity !== null &&
    !validAgentIdentity(value.agent_identity)
  ) {
    return false;
  }
  if (
    value.bedrock_api_key !== undefined &&
    value.bedrock_api_key !== null &&
    !validBedrockApiKey(value.bedrock_api_key)
  ) {
    return false;
  }
  if (value.auth_mode !== undefined && value.auth_mode !== null && typeof value.auth_mode !== "string") {
    return false;
  }

  const mode =
    typeof value.auth_mode === "string"
      ? value.auth_mode
      : nonEmptyString(value.personal_access_token)
        ? "personalAccessToken"
        : value.bedrock_api_key
          ? "bedrockApiKey"
          : nonEmptyString(value.OPENAI_API_KEY)
            ? "apikey"
            : "chatgpt";
  switch (mode) {
    case "apikey":
      return nonEmptyString(value.OPENAI_API_KEY);
    case "chatgpt":
      return validCodexTokens(value.tokens, true) || validRegisteredAgentIdentity(value.agent_identity);
    case "chatgptAuthTokens":
      return (
        validCodexTokens(value.tokens, false) &&
        isRecord(value.tokens) &&
        nonEmptyString(value.tokens.account_id)
      );
    case "agentIdentity":
      return validAgentIdentity(value.agent_identity);
    case "personalAccessToken":
      return nonEmptyString(value.personal_access_token);
    case "bedrockApiKey":
      return validBedrockApiKey(value.bedrock_api_key);
    case "headers":
    default:
      return false;
  }
}

function validCodexTokens(value, requireRefresh) {
  if (!isRecord(value)) return false;
  if (
    !validJwt(value.id_token) ||
    !nonEmptyString(value.access_token) ||
    typeof value.refresh_token !== "string" ||
    (requireRefresh && !nonEmptyString(value.refresh_token))
  ) {
    return false;
  }
  return value.account_id === undefined || value.account_id === null || typeof value.account_id === "string";
}

function validAgentIdentity(value) {
  if (typeof value === "string") return validJwt(value);
  return validRegisteredAgentIdentity(value);
}

function validRegisteredAgentIdentity(value) {
  if (!isRecord(value)) return false;
  return (
    nonEmptyString(value.agent_runtime_id) &&
    nonEmptyString(value.agent_private_key) &&
    nonEmptyString(value.account_id) &&
    nonEmptyString(value.chatgpt_user_id) &&
    nonEmptyString(value.plan_type) &&
    typeof value.chatgpt_account_is_fedramp === "boolean" &&
    (value.email === undefined || value.email === null || typeof value.email === "string") &&
    (value.task_id === undefined || value.task_id === null || typeof value.task_id === "string")
  );
}

function validBedrockApiKey(value) {
  return isRecord(value) && nonEmptyString(value.api_key) && nonEmptyString(value.region);
}

function validJwt(value) {
  if (typeof value !== "string") return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return false;
  try {
    return isRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
  } catch {
    return false;
  }
}

function optionalString(value) {
  return value === undefined || value === null || typeof value === "string";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function checkClaude() {
  const issues = [];
  const command = required(process.env.CLANKIE_CLAUDE_EXECUTABLE, "executable_not_configured", issues);
  required(process.env.CLANKIE_CLAUDE_MODEL, "model_not_configured", issues);
  if (command) await executable(command, "executable_unavailable", issues, probeEnvironment);

  const direct = Boolean(process.env.ANTHROPIC_API_KEY);
  const bedrock =
    enabled(process.env.CLAUDE_CODE_USE_BEDROCK) &&
    Boolean(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION) &&
    Boolean(process.env.AWS_ACCESS_KEY_ID) &&
    Boolean(process.env.AWS_SECRET_ACCESS_KEY);
  const vertex =
    enabled(process.env.CLAUDE_CODE_USE_VERTEX) &&
    Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS) &&
    (await readable(process.env.GOOGLE_APPLICATION_CREDENTIALS)) &&
    Boolean(process.env.CLOUD_ML_REGION) &&
    Boolean(process.env.ANTHROPIC_VERTEX_PROJECT_ID);
  if (!direct && !bedrock && !vertex) {
    issues.push(
      issue(
        process.env.CLAUDE_CODE_OAUTH_TOKEN ? "consumer_oauth_not_compliant" : "auth_unavailable",
        "Use an Anthropic API key or complete Bedrock/Vertex credentials; consumer/Max OAuth is not accepted.",
      ),
    );
  }
  return { provider: "claude", issues };
}

async function checkPi() {
  const issues = [];
  const model = required(process.env.CLANKIE_PI_MODEL, "model_not_configured", issues);
  const origin = parseExactLoopback(process.env.CLANKIE_PI_OLLAMA_URL, issues);
  await verifyBundledPiPin(issues);
  if (process.platform !== "darwin" || !(await executablePath("/usr/bin/sandbox-exec"))) {
    issues.push(issue("seatbelt_unavailable", "The real-provider gate requires macOS Seatbelt."));
  } else {
    await commandSucceeds("/usr/bin/sandbox-exec", ["-p", "(version 1) (allow default)", "/usr/bin/true"], {
      PATH: process.env.PATH,
    }).catch(() => issues.push(issue("seatbelt_unavailable", "Seatbelt could not enforce a probe profile.")));
  }
  if (origin && model) {
    try {
      const response = await fetch(new URL("/api/tags", origin), { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error("not ready");
      const body = await response.json();
      const models = Array.isArray(body?.models)
        ? body.models
            .flatMap((entry) => [entry?.name, entry?.model])
            .filter((value) => typeof value === "string")
        : [];
      if (!models.includes(model)) {
        issues.push(issue("model_unavailable", "The exact configured model is not present in local Ollama."));
      }
    } catch {
      issues.push(issue("ollama_unreachable", "The exact localhost Ollama model endpoint is unavailable."));
    }
  }
  return { provider: "pi", issues };
}

async function verifyBundledPiPin(issues) {
  try {
    const manifest = JSON.parse(await readFile(join(repoRoot, "packages/worker-pi/package.json"), "utf8"));
    const pinned = manifest.dependencies?.["@earendil-works/pi-coding-agent"];
    const lock = await readFile(join(repoRoot, "pnpm-lock.yaml"), "utf8");
    if (
      pinned !== EXPECTED_PI_VERSION ||
      !lock.includes(`'@earendil-works/pi-coding-agent@${EXPECTED_PI_VERSION}'`)
    ) {
      throw new Error("pin mismatch");
    }
    const rpcEntry = join(
      repoRoot,
      "packages/worker-pi/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js",
    );
    await access(rpcEntry, constants.R_OK);
  } catch {
    issues.push(issue("bundled_pin_mismatch", "The bundled Pi dependency must remain pinned at 0.80.6."));
  }
}

function parseExactLoopback(value, issues) {
  if (!value?.trim()) {
    issues.push(issue("ollama_url_not_configured", "Set an exact localhost HTTP Ollama origin."));
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      throw new Error("not exact loopback");
    }
    return url;
  } catch {
    issues.push(issue("ollama_url_invalid", "Use a credential-free exact localhost HTTP origin."));
    return undefined;
  }
}

function required(value, code, issues) {
  const normalized = value?.trim();
  if (!normalized) issues.push(issue(code, "Configure this required readiness setting."));
  return normalized || undefined;
}

async function executable(command, code, issues, environment = probeEnvironment) {
  try {
    await commandSucceeds(command, ["--version"], environment);
  } catch {
    issues.push(issue(code, "Install or configure the provider executable."));
  }
}

async function commandSucceeds(command, args, env) {
  await execFileAsync(command, args, { env, timeout: 5_000, maxBuffer: 64 * 1024 });
}

function executablePath(path) {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function readable(path) {
  return access(path, constants.R_OK).then(
    () => true,
    () => false,
  );
}

function enabled(value) {
  return value?.trim().toLowerCase() === "true";
}

function pickEnvironment(source, names) {
  const selected = {};
  for (const name of names) if (source[name] !== undefined) selected[name] = source[name];
  return selected;
}

function issue(code, message) {
  return { code, message };
}
