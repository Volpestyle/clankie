import { mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname } from "node:path";
import { probeProcess } from "@clankie/fleet-resources";
import { z } from "zod";
import { OperatorSeatMigrationSchema } from "@clankie/protocol";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../../tui/bin/update-files.ts";

type Migration = z.infer<typeof OperatorSeatMigrationSchema>;
const Journal = z.array(OperatorSeatMigrationSchema);

/** A deliberate pause survives service restarts. No method signals a process or replays a receipt. */
export class OperatorSeatMigrations {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  private read(): Migration[] {
    try {
      return Journal.parse(readPrivateJson(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  held(conversationId: string): boolean {
    return this.read().some((row) => row.conversationId === conversationId && row.state !== "ready");
  }
  forConversation(conversationId: string): Migration | undefined {
    return this.read().findLast((row) => row.conversationId === conversationId && row.state !== "ready");
  }
  pending(): Migration[] {
    return this.read().filter((row) => row.state !== "ready");
  }
  get(id: string): Migration {
    const row = this.read().find((row) => row.id === id);
    if (!row) throw Error("Unknown migration; do not create a replacement for an uncertain original");
    return row;
  }
  private save(row: Migration): Migration {
    const records = this.read();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    privateDirectory(dirname(this.path));
    writePrivateJson(this.path, [...records.filter((previous) => previous.id !== row.id), row]);
    for (const path of [this.path, dirname(this.path)]) {
      const fd = openSync(path, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return row;
  }
  prepare(input: Omit<Migration, "state">): Migration {
    const previous = this.read().find((row) => row.id === input.id);
    if (previous) {
      const { state: _state, ...original } = previous;
      if (JSON.stringify(original) !== JSON.stringify(input)) throw Error("Migration identity changed");
      return previous;
    }
    if (this.held(input.conversationId)) throw Error("An original migration already holds this conversation");
    return this.save(OperatorSeatMigrationSchema.parse({ ...input, state: "held" }));
  }
  async claim(
    id: string,
    identity: { sessionId: string; conversationId: string; cwd: string; profile: string },
  ): Promise<Migration> {
    const row = this.get(id);
    if (row.state !== "held")
      throw Error("Migration launch was already claimed; inspect its original status, never launch again");
    if (Object.entries(identity).some(([key, value]) => row[key as keyof Migration] !== value))
      throw Error("Migration requires the exact original session, conversation, cwd and profile");
    for (const process of row.processes)
      if ((await probeProcess(process)) !== "exited")
        throw Error("Old native exit is unconfirmed; migration remains held");
    if (JSON.stringify(this.get(id)) !== JSON.stringify(row))
      throw Error("Migration changed while proving exit; inspect the original status");
    // Persist before the launcher can spawn. An interrupted spawn is never retried.
    return this.save({ ...row, state: "resuming" });
  }
  complete(id: string): Migration {
    const row = this.get(id);
    if (row.state !== "resuming") throw Error("No exact-session resume has been claimed");
    return this.save({ ...row, state: "ready" });
  }
}
