import { mkdtemp, readFile, writeFile, rm, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createLocalTracker } from "../src/tracker-local.ts";

it("reads preexisting fixture get_user without changing persisted domain bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "strict-fixture-user-"));
  try {
    const tracker = createLocalTracker({ directory: root });
    const user = await tracker.call("get_user", { query: "me" }); // explicit setup only
    const before = await readFile(join(root, "tracker.json"));
    const result = await tracker.strictGetUser(async (snapshot) => {
      expect(snapshot.storeId).toBeTruthy();
      return () => {};
    });
    expect(result.user).toEqual(user);
    expect(await readFile(join(root, "tracker.json"))).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses absent stores, custom clocks and rollover without seed or domain writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "strict-fixture-refusal-"));
  try {
    const absent = join(root, "absent");
    await expect(
      createLocalTracker({ directory: absent }).strictGetUser(async () => () => {}),
    ).rejects.toThrow();
    await expect(lstat(absent)).rejects.toMatchObject({ code: "ENOENT" });
    const tracker = createLocalTracker({ directory: root, project: "Fixture" });
    await tracker.call("get_user", { query: "me" });
    const path = join(root, "tracker.json"),
      before = await readFile(path);
    let clockCalled = false;
    await expect(
      createLocalTracker({
        directory: root,
        clock: () => {
          clockCalled = true;
          return new Date();
        },
      }).strictGetUser(async () => () => {}),
    ).rejects.toThrow("custom callbacks");
    expect(clockCalled).toBe(false);
    expect(await readFile(path)).toEqual(before);
    const store = JSON.parse(before.toString());
    store.cycles = [
      {
        id: randomUUID(),
        projectId: store.projects[0].id,
        number: 1,
        startsAt: "2000-01-01T00:00:00.000Z",
        endsAt: "2000-01-02T00:00:00.000Z",
        createdAt: "2000-01-01T00:00:00.000Z",
      },
    ];
    await writeFile(path, JSON.stringify(store));
    const expired = await readFile(path);
    await expect(tracker.strictGetUser(async () => () => {})).rejects.toThrow("rollover");
    expect(await readFile(path)).toEqual(expired);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses symlink stores and changed locked bytes after awaited preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "strict-fixture-target-"));
  try {
    const tracker = createLocalTracker({ directory: root });
    await tracker.call("get_user", { query: "me" });
    const path = join(root, "tracker.json"),
      before = await readFile(path);
    await expect(
      tracker.strictGetUser(async () => {
        await writeFile(path, `${before.toString()}\n`);
        return () => {};
      }),
    ).rejects.toThrow("target changed");
    const target = join(root, "elsewhere.json");
    await writeFile(target, before);
    await rm(path);
    await symlink(target, path);
    await expect(tracker.strictGetUser(async () => () => {})).rejects.toThrow();
    expect(await readFile(target)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
