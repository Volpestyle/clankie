import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Node's built-in fetch runs on the undici that ships inside Node. Before
// undici 8.10.0 (Node 26.7 ships 8.9.0), reusing an idle keep-alive socket
// waits on an unref'd setImmediate, so on an otherwise idle event loop a
// request sits unsent until some unrelated timer or socket wakes the loop:
// tens to hundreds of milliseconds per request (nodejs/undici#5600, #5606).
// When Node's copy is that old, fetch here dispatches through this package's
// pinned undici instead. Importing this module installs it.
const FIXED = [8, 10, 0];
const bundled = (process.versions.undici ?? "").split(".").map(Number);
const older = (version: number[]) => {
  for (const [index, part] of FIXED.entries()) {
    const value = version[index] ?? 0;
    if (Number.isNaN(value)) return false;
    if (value !== part) return value < part;
  }
  return false;
};

if (process.versions.undici !== undefined && older(bundled)) {
  // Node's own environment-proxy opt-in installs a proxy dispatcher; keep it.
  const envProxy = process.env.NODE_USE_ENV_PROXY === "1" || process.execArgv.includes("--use-env-proxy");
  setGlobalDispatcher(envProxy ? new EnvHttpProxyAgent() : new Agent());
}
