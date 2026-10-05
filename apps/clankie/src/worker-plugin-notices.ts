import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";

/** Display metadata only. A client's reported version never changes its tool authority. */
export class WorkerPluginNotices {
  private readonly pending = new Map<string, Promise<boolean>>();
  private expectedVersion: string;
  private readonly options: {
    directory: string;
    expectedVersion: string;
    report(fleet: string, pane: string, args: readonly string[]): Promise<unknown>;
  };
  constructor(options: WorkerPluginNotices["options"]) {
    this.options = options;
    this.expectedVersion = options.expectedVersion;
  }
  expected(): string {
    return this.expectedVersion;
  }
  expect(version: string): void {
    if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Invalid worker plugin version");
    this.expectedVersion = version;
  }

  async observe(identity: LocalFleetIdentity, version: string): Promise<boolean> {
    if (!/^\d+\.\d+\.\d+$/u.test(version) || !(await identity.validate())) return false;
    const proof = await identity.projectProof?.();
    if (!proof || proof.fleet !== (identity.fleet ?? "default") || proof.pane !== identity.pane) return false;
    const expectedVersion = this.expectedVersion;
    const key = createHash("sha256")
      .update(
        JSON.stringify([proof.fleet, proof.pane, proof.nativeOccupantId, proof.processes, expectedVersion]),
      )
      .digest("hex");
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = (async () => {
      const path = join(this.options.directory, `${key}.json`);
      const prior = await readFile(path, "utf8").catch(() => undefined);
      if (prior === JSON.stringify({ version })) return true;
      const fresh = await identity.projectProof?.();
      if (
        !(await identity.validate()) ||
        JSON.stringify(fresh) !== JSON.stringify(proof) ||
        this.expectedVersion !== expectedVersion
      )
        return false;
      const expected = expectedVersion.split(".").map(Number),
        loaded = version.split(".").map(Number);
      const difference = loaded.findIndex((part, index) => part !== expected[index]);
      const older = difference !== -1 && loaded[difference]! < expected[difference]!;
      await this.options.report(
        proof.fleet,
        proof.pane,
        older
          ? [
              "--token",
              `clankie-plugin=Clankie plugin ${version} is older than ${expectedVersion}. Save this session, then restart/resume this harness in this pane to load the refreshed plugin. Nothing was restarted.`,
            ]
          : ["--clear-token", "clankie-plugin"],
      );
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify({ version }), { mode: 0o600 });
      return true;
    })();
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }
}
