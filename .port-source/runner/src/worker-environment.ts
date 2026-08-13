const ALLOWED_WORKER_ENVIRONMENT_KEYS = [
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
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NVM_DIR",
  "VOLTA_HOME",
  "PNPM_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOROOT",
  "GOPATH",
] as const;

/** Builds the complete child environment; runner/captain/connector variables are never inherited. */
export function buildWorkerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_WORKER_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
