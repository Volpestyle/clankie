/** One shared immutable model-tool profile, also used by the credential-free probe. */
export function nativePermissionProfile(cwd) {
  if (!/^\/eval\/tasks\/[a-z0-9-]+$/u.test(cwd)) throw Error("Invalid allocated native workspace");
  return {
    filesystem: {
      ":root": "deny",
      ":minimal": "read",
      [cwd]: "write",
      [`${cwd}/.git`]: "read",
      [`${cwd}/.codex`]: "read",
      [`${cwd}/config.toml`]: "deny",
      "/tmp": "write",
    },
    network: { enabled: false },
  };
}
export function nativePermissionConfig(cwd) {
  const profile = nativePermissionProfile(cwd);
  const filesystem = Object.entries(profile.filesystem)
    .map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`)
    .join(",");
  return [
    'approval_policy="never"',
    "mcp_servers={}",
    "features.multi_agent=false",
    'web_search="disabled"',
    'default_permissions="lead_eval"',
    `permissions.lead_eval.filesystem={${filesystem}}`,
    "permissions.lead_eval.network.enabled=false",
  ];
}

/** Native parent config readers run outside the model sandbox: fence their inputs first. */
export async function validateNativeLaunchState({ root, hostCwd, accountHome }) {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const present = (file) => {
    try {
      return fs.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  };
  for (let current = hostCwd; ; current = path.dirname(current)) {
    if (fs.realpathSync(current) !== current || !fs.lstatSync(current).isDirectory())
      throw Error("Aliased native configuration ancestry");
    for (const config of [path.join(current, "config.toml"), path.join(current, ".codex", "config.toml")])
      if (present(config)) throw Error("Native project configuration layers are not admitted");
    const codex = path.join(current, ".codex");
    const codexStat = present(codex);
    if (codexStat && (codexStat.isSymbolicLink() || !codexStat.isDirectory() || fs.readdirSync(codex).length))
      throw Error("Native project control directory must be absent or empty");
    if (current === root) break;
    if (path.dirname(current) === current || !current.startsWith(root + path.sep))
      throw Error("Native configuration ancestry escaped allocation");
  }
  const stat = fs.lstatSync(accountHome);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(accountHome) !== accountHome ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw Error("Native auth home must be a fresh owned private directory");
  const files = fs.readdirSync(accountHome);
  if (files.length !== 1 || files[0] !== "auth.json")
    throw Error("Only selected native auth material may enter a fresh account home");
  const auth = fs.lstatSync(path.join(accountHome, "auth.json"));
  if (
    !auth.isFile() ||
    auth.isSymbolicLink() ||
    auth.nlink !== 1 ||
    auth.uid !== process.getuid() ||
    auth.mode & 0o077
  )
    throw Error("Native auth material must be an owned private regular file");
  // Content/account identity is checked by the native provider monitor, never parsed here as attestation.
}

/** Validate the real pinned config/read serialization; retain only a provenance hash. */
export async function validateEffectiveNativeConfig(response, { cwd, codexHome }) {
  const { isDeepStrictEqual } = await import("node:util");
  const { createHash } = await import("node:crypto");
  const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const empty = (value) => value == null || (plain(value) && Object.keys(value).length === 0);
  const compact = (value) =>
    Array.isArray(value)
      ? value.map(compact)
      : plain(value)
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, entry]) => entry !== null)
              .map(([key, entry]) => [key, compact(entry)]),
          )
        : value;
  const expected = {
    approval_policy: "never",
    mcp_servers: {},
    features: { multi_agent: false },
    web_search: "disabled",
    default_permissions: "lead_eval",
    permissions: { lead_eval: nativePermissionProfile(cwd) },
  };
  if (
    !plain(response?.config) ||
    !plain(response.origins) ||
    !Array.isArray(response.layers) ||
    !response.layers.length
  )
    throw Error("Complete native configuration provenance unavailable");
  let session = 0;
  for (const layer of response.layers) {
    if (!plain(layer?.name) || typeof layer.version !== "string" || !plain(layer.config))
      throw Error("Unknown native configuration layer schema");
    const name = layer.name;
    if (name.type === "sessionFlags") {
      session++;
      if (!isDeepStrictEqual(layer.config, expected)) throw Error("Native session configuration changed");
    } else if (name.type === "system" && name.file === "/etc/codex/config.toml") {
      if (!empty(layer.config)) throw Error("Unexpected native system configuration");
    } else if (name.type === "user" && name.file === `${codexHome}/config.toml` && name.profile == null) {
      if (
        !empty(layer.config) &&
        !isDeepStrictEqual(layer.config, { projects: { [cwd]: { trust_level: "trusted" } } })
      )
        throw Error("Unexpected native user configuration");
    } else if (
      name.type === "project" &&
      ["/eval/.codex", "/eval/tasks/.codex", `${cwd}/.codex`].includes(name.dotCodexFolder)
    ) {
      if (!empty(layer.config)) throw Error("Native project configuration is not empty");
    } else throw Error("Unrecognized native configuration authority");
  }
  const config = compact(response.config);
  if (
    session !== 1 ||
    config.approval_policy !== "never" ||
    config.web_search !== "disabled" ||
    config.default_permissions !== "lead_eval" ||
    !isDeepStrictEqual(config.permissions, expected.permissions) ||
    !isDeepStrictEqual(config.features, expected.features) ||
    !empty(config.mcp_servers) ||
    !empty(config.plugins) ||
    !empty(config.hooks) ||
    config.notify != null ||
    !empty(config.model_providers) ||
    (config.model_provider != null && config.model_provider !== "openai")
  )
    throw Error("Native effective execution configuration is not the locked eval policy");
  const summary = {
    profile: expected.permissions,
    layers: response.layers.map(({ name, version }) => ({ name, version })),
  };
  return {
    sha256: createHash("sha256").update(JSON.stringify(summary)).digest("hex"),
    layerCount: response.layers.length,
  };
}
