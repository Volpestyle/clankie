import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function cleanEnv(root) {
  // Allowlist, not a denylist: provider keys, service bearers, MCP grants and
  // inherited harness sockets must never cross this boundary.
  const claudeAuth = join(root, "home", ".claude", ".credentials.json");
  const token = existsSync(claudeAuth)
    ? JSON.parse(readFileSync(claudeAuth, "utf8")).claudeAiOauth?.accessToken
    : undefined;
  return {
    ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: join(root, "home"),
    CFFIXED_USER_HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    XDG_CACHE_HOME: join(root, "home", ".cache"),
    CODEX_HOME: join(root, "home", ".codex"),
    CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
    TMPDIR: join(root, "tmp"),
    TMPPREFIX: join(root, "tmp", "zsh"),
    CLAUDE_CODE_TMPDIR: join(root, "tmp"),
    LANG: "en_US.UTF-8",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    TERM: "dumb",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    // Claude 2.1.285 cross-session inbox is unnecessary in an isolated trial.
    CLAUDE_CODE_HARBOR_KITE: "0",
    CLAUDE_CODE_CERT_STORE: "bundled",
  };
}

export function executable(name) {
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  if (result.status !== 0) throw Error(`${name} is not installed`);
  return realpathSync(result.stdout.trim());
}

export function subscriptionAuth(harness) {
  const home = homedir();
  if (harness === "codex") {
    const auth = JSON.parse(
      readFileSync(join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json"), "utf8"),
    );
    if (auth.auth_mode !== "chatgpt" || !auth.tokens?.access_token || auth.OPENAI_API_KEY) {
      throw Error("Codex must be logged in with ChatGPT, not an API key");
    }
    return JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { ...auth.tokens, refresh_token: "" },
      last_refresh: auth.last_refresh,
    });
  }
  const result = spawnSync(executable("claude"), ["auth", "status"], { encoding: "utf8" });
  let status;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    throw Error("Cannot verify Claude subscription login");
  }
  if (
    !status.loggedIn ||
    status.authMethod !== "claude.ai" ||
    !["max", "pro", "team", "enterprise"].includes(status.subscriptionType)
  ) {
    throw Error("Claude must be logged in with a Claude subscription");
  }
  // Read the CLI's own subscription credential; copy only OAuth into the attempt.
  // Keychain access stays in the parent, outside the model sandbox.
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  let auth;
  try {
    auth = JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8"));
  } catch {
    auth = {};
  }
  if (!auth.claudeAiOauth?.accessToken) {
    const credential = spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8" },
    );
    try {
      auth = JSON.parse(credential.stdout);
    } catch {
      throw Error("Claude subscription credential unavailable");
    }
  }
  if (!auth.claudeAiOauth?.accessToken || !auth.claudeAiOauth?.scopes?.includes("user:inference")) {
    throw Error("Claude subscription inference OAuth credential missing");
  }
  return JSON.stringify({ claudeAiOauth: { ...auth.claudeAiOauth, refreshToken: "" } });
}

export function installAuth(root, harness, auth) {
  const env = cleanEnv(root);
  for (const path of [
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    env.TMPDIR,
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const path =
    harness === "codex"
      ? join(env.CODEX_HOME, "auth.json")
      : join(env.CLAUDE_CONFIG_DIR, ".credentials.json");
  writeFileSync(path, auth, { mode: 0o600 });
  if (harness === "claude")
    writeFileSync(
      join(env.CLAUDE_CONFIG_DIR, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
      { mode: 0o600 },
    );
  return path;
}

const quote = (value) => JSON.stringify(value);
function sandboxProfile(root, binary, { network = true, extraRead = [] } = {}) {
  if (process.platform !== "darwin")
    throw Error("Eval isolation currently requires macOS sandbox-exec; refusing an unsandboxed run");
  // Default deny reads/writes. Only system runtimes and this attempt are visible.
  // In particular ~/.config/clankie, ~/.clankie, keychains and the source checkout
  // are absent. Local service sockets are denied; HTTPS and the system DNS socket are allowed.
  return `(version 1)
(deny default)
(allow process-exec process-fork sysctl-read file-map-executable dynamic-code-generation)
(allow signal (target self) (target same-sandbox))
(allow mach-per-user-lookup)
(allow process-info* (target self) (target same-sandbox))
(allow process-codesigning-status* (target self))
(allow mach-lookup (global-name "com.apple.FSEvents") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.logd") (global-name "com.apple.mDNSResponder") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.system.logger") (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon"))
(allow user-preference-read (preference-domain "com.openai.codex") (preference-domain "com.anthropic.claudecode") (preference-domain ".GlobalPreferences"))
(allow ipc-posix-shm-read* (ipc-posix-name "apple.cfprefs.daemonv1") (ipc-posix-name "apple.cfprefs.${process.getuid()}v1"))
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt/homebrew") (subpath "/Library/Apple") (subpath "/Library/Managed Preferences") (subpath "/Library/Preferences") (subpath "/private/etc") (subpath "/dev") (subpath ${quote(root)}) (subpath ${quote(dirname(binary))}) ${extraRead.map((p) => `(literal ${quote(p)})`).join(" ")})
(allow file-write* ${["worktree", "home", "tmp", "seed"].map((name) => `(subpath ${quote(join(root, name))})`).join(" ")} (literal "/dev/null") (literal "/dev/tty"))
(deny file-write-unlink ${["worktree", "home", "tmp", "seed"].map((name) => `(literal ${quote(join(root, name))})`).join(" ")})
${network ? '(allow network-outbound (remote tcp "*:443") (literal "/private/var/run/mDNSResponder"))\n(deny network-outbound (remote ip "localhost:*"))' : ""}
`;
}

export async function executeSandbox({
  root,
  binary,
  args,
  input = "",
  timeoutMs = 120000,
  network = true,
  extraRead = [],
}) {
  const profile = join(root, network ? "model.sb" : "check.sb");
  writeFileSync(profile, sandboxProfile(root, binary, { network, extraRead }));
  const started = Date.now();
  return await new Promise((resolve) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, binary, ...args], {
      cwd: join(root, "worktree"),
      env: cleanEnv(root),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      overflow = false;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const capture = (key) => (data) => {
      if (key === "stdout") stdout += data;
      else stderr += data;
      if (stdout.length + stderr.length > 8_000_000) {
        overflow = true;
        kill();
      }
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      kill();
      resolve({ stdout, stderr, exitCode, signal, timedOut, overflow, wallMs: Date.now() - started });
    });
  });
}

export function removeAuth(root) {
  // OAuth rotations and all credential-bearing caches are attempt-local and
  // removed even on errors; evidence retains neither home nor environment.
  rmSync(join(root, "home"), { recursive: true, force: true });
}
