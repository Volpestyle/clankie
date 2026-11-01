import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { BodyTransfer } from "../src/body-transfer.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function body(label: string): Promise<BodyTransfer> {
  const root = await mkdtemp(join(tmpdir(), `clankie-body-${label}-`));
  roots.push(root);
  const bodyRoots = {
    state: join(root, "state"),
    memory: join(root, "memory"),
    attachments: join(root, "files"),
  };
  for (const directory of Object.values(bodyRoots)) await mkdir(directory, { recursive: true });
  return new BodyTransfer({
    roots: bodyRoots,
    settings: new SettingsStore(join(root, "settings.json")),
    label,
  });
}

const ready = async (commit: () => Promise<void>) => {
  await commit();
  return "ready" as const;
};

// #101: S froze for A; A applied but its answer was lost. B never saw the move.
it("keeps the source frozen when a body it didn't freeze for answers", async () => {
  const source = await body("s");
  const bystander = await body("b");
  const transferId = randomUUID();
  await source.freeze({ transferId, destination: "https://a.example" }, ready);

  const discarded = await bystander.discard({ transferId });
  expect(discarded.transfers?.[transferId]?.outcome).toBe("burned");
  await expect(
    source.abort({ transferId, destination: "https://b.example", discarded }),
  ).rejects.toMatchObject({ code: "answer_not_from_recorded_destination" });
  await expect(
    source.release({
      transferId,
      destination: "https://b.example",
      activation: { ...source.authority(), state: "active", dormant: false },
    }),
  ).rejects.toMatchObject({ code: "answer_not_from_recorded_destination" });
  expect(source.authority()).toMatchObject({ state: "frozen", transferId });

  // The recorded destination burning the id is still the way back.
  const destination = await body("a");
  const burned = await destination.discard({ transferId });
  await expect(
    source.abort({ transferId, destination: "https://a.example", discarded: burned }),
  ).resolves.toMatchObject({ state: "active" });
});
