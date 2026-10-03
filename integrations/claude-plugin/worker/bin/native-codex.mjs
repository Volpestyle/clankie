import { realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";

/** Resolve installed native Codex, never execute a .cmd/PowerShell or dotfiles launcher. */
export async function nativeCodexExecutable({
  env = process.env,
  platform = process.platform,
  canonical = async (path) => {
    if (!(await stat(path)).isFile()) throw new Error("Not a file");
    return realpath(path);
  },
} = {}) {
  if (platform !== "win32") return "codex";
  const value = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const directories = new Set(
    (value("PATH") ?? "")
      .split(";")
      .map((entry) => entry.replace(/^"(.*)"$/u, "$1"))
      .filter((entry) => win32.isAbsolute(entry)),
  );
  const appData = value("APPDATA");
  if (appData && win32.isAbsolute(appData)) directories.add(win32.join(appData, "npm"));
  const found = new Map();
  const inspect = async (candidate) => {
    try {
      const resolved = await canonical(candidate);
      found.set(win32.normalize(resolved).toLowerCase(), resolved);
    } catch {
      /* Not installed at this fixed path. */
    }
  };
  for (const directory of directories) {
    await inspect(win32.join(directory, "codex.exe"));
    try {
      await canonical(win32.join(directory, "codex.cmd"));
    } catch {
      continue;
    }
    const packageRoot = win32.join(directory, "node_modules", "@openai", "codex");
    await inspect(
      win32.join(
        packageRoot,
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ),
    );
    await inspect(win32.join(packageRoot, "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"));
  }
  if (found.size !== 1)
    throw new Error(
      found.size
        ? "Multiple installed native Codex executables; resolve the ambiguous installation before setup."
        : "No installed native Codex executable found; command shims do not prove the native installation.",
    );
  return [...found.values()][0];
}
