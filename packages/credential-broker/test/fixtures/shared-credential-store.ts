import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileCredentialStore, KeychainCredentialStore } from "../../src/credential-store.ts";

/** Disk-backed stand-in for security(1), so process tests never touch real secrets. */
export function sharedCredentialStore(kind: "file" | "keychain", directory: string) {
  if (kind === "file") return new FileCredentialStore(join(directory, "credentials.json"));
  return new KeychainCredentialStore({
    service: `clankie-test:${directory}`,
    execFile: async (_file, args) => {
      const path = join(directory, "fake-keychain.json");
      let items: Record<string, string>;
      try {
        items = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        items = {};
      }
      const account = args[args.indexOf("-a") + 1]!;
      if (args[0] === "find-generic-password") {
        if (items[account] === undefined) throw new Error("item could not be found");
        return { stdout: items[account] + "\n", stderr: "" };
      }
      if (args[0] === "delete-generic-password") {
        if (items[account] === undefined) throw new Error("item could not be found");
        delete items[account];
      } else if (args[0] === "add-generic-password") {
        items[account] = args[args.indexOf("-w") + 1]!;
      } else {
        throw new Error("unexpected security command");
      }
      await writeFile(path, JSON.stringify(items), { mode: 0o600 });
      return { stdout: "", stderr: "" };
    },
  });
}
