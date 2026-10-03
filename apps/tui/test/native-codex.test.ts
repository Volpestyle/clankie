import { expect, it } from "vitest";
import { win32 } from "node:path";
import { nativeCodexExecutable } from "../../../integrations/claude-plugin/worker/bin/native-codex.mjs";
const npm = "C:\\Users\\owner\\AppData\\Roaming\\npm";
const modern = win32.join(
  npm,
  "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
);
const legacy = win32.join(npm, "node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/codex/codex.exe");
function fixture(files: Record<string, string>, env: NodeJS.ProcessEnv = { Path: npm }) {
  const seen: string[] = [];
  return {
    seen,
    run: () =>
      nativeCodexExecutable({
        platform: "win32",
        env,
        canonical: async (path) => {
          seen.push(path);
          if (!files[path]) throw new Error("missing");
          return files[path]!;
        },
      }),
  };
}
it.each([modern, legacy])(
  "resolves only fixed installed npm native layout %s without running its shim",
  async (binary) => {
    const f = fixture({ [win32.join(npm, "codex.cmd")]: win32.join(npm, "codex.cmd"), [binary]: binary });
    expect(await f.run()).toBe(binary);
    expect(f.seen.every((path) => !path.includes(".codex-"))).toBe(true);
  },
);
it("deduplicates canonical executable paths across PATH aliases", async () => {
  const f = fixture(
    { "C:\\one\\codex.exe": "C:\\native\\codex.exe", "C:\\two\\codex.exe": "c:\\NATIVE\\codex.exe" },
    { PATH: "C:\\one;C:\\two" },
  );
  expect((await f.run()).toLowerCase()).toBe("c:\\native\\codex.exe");
});
it("refuses ambiguous native installs instead of selecting one by PATH order", async () => {
  const f = fixture(
    { "C:\\one\\codex.exe": "C:\\one\\codex.exe", "C:\\two\\codex.exe": "C:\\two\\codex.exe" },
    { PATH: "C:\\one;C:\\two" },
  );
  await expect(f.run()).rejects.toThrow("Multiple installed");
});
it("uses the fixed per-user npm root even when SSH PATH omits it", async () => {
  const f = fixture(
    { [win32.join(npm, "codex.cmd")]: win32.join(npm, "codex.cmd"), [modern]: modern },
    { APPDATA: win32.dirname(npm), PATH: "relative;." },
  );
  expect(await f.run()).toBe(modern);
  expect(f.seen.every(win32.isAbsolute)).toBe(true);
});
it("does not accept a shim alone, a staging sibling, or a native helper outside its installed package", async () => {
  const f = fixture({
    [win32.join(npm, "codex.cmd")]: win32.join(npm, "codex.cmd"),
    [modern.replace("\\codex\\", "\\.codex-staging\\")]: modern,
  });
  await expect(f.run()).rejects.toThrow("No installed native");
});
it("keeps non-Windows native command discovery unchanged", async () => {
  expect(await nativeCodexExecutable({ platform: "darwin", env: {} })).toBe("codex");
});
