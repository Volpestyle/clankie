import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlEventStore } from "../src/index.ts";

const event = {
  id: "e1",
  occurredAt: "2026-07-10T00:00:00.000Z",
  missionId: "m1",
  correlationId: "c1",
  profileHash: "p1",
  type: "mission.started",
  data: {},
};

describe("JsonlEventStore", () => {
  it("detects tampering in the append-only chain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-events-"));
    const path = join(directory, "events.jsonl");
    const store = new JsonlEventStore(path);
    await store.append(event);
    expect(await store.verify()).toMatchObject({ valid: true, count: 1 });
    await writeFile(path, `${JSON.stringify({ ...(await store.readAll())[0], hash: "tampered" })}\n`, "utf8");
    expect((await store.verify()).valid).toBe(false);
  });
});
