import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveredFileStore, type StoredOwnerAttachment } from "../src/delivered-files.ts";
import { deliverToFleetSeat, readFleetSeatImage } from "../src/fleet-seat-files.ts";
import type { FleetShellRun, HerdrFleet } from "../src/herdr-fleet.ts";

// ADR 0316 across a real shell boundary: the linked machine is this machine's
// own `sh` with its own home folder, running exactly the commands the service
// sends over ssh, and the copy lands where scp would put it.

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(300 * 1024, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const fleet: HerdrFleet = {
  id: "pc9",
  session: "default",
  ssh: { host: "pc9.example", shell: "posix" },
} as HerdrFleet;

async function machine() {
  const root = await mkdtemp(join(tmpdir(), "clankie-linked-"));
  roots.push(root);
  const home = join(root, "home");
  const workspace = join(root, "work", "kh2");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const commands: string[] = [];
  const shell: FleetShellRun = async (command) => {
    commands.push(command);
    // ssh hands the command to the account's login shell.
    const { stdout } = await run("sh", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: home },
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  };
  const copied: string[] = [];
  const copy = async (source: string, destination: string) => {
    copied.push(destination);
    await cp(source, join(home, destination), { recursive: true, errorOnExist: true, force: false });
  };
  return { root, home, workspace, shell, copy, commands, copied };
}

async function stored(root: string, filename: string, bytes: Buffer): Promise<StoredOwnerAttachment> {
  const files = new DeliveredFileStore(join(root, "attachments"));
  const begun = await files.beginUpload({
    conversationId: "conv",
    filename,
    mediaType: bytes[0] === 0xff ? "image/jpeg" : "image/png",
    byteCount: bytes.byteLength,
    sha256: sha(bytes),
  });
  if (begun.status !== "uploading") throw new Error("uploading expected");
  for (let offset = 0; offset < bytes.byteLength; offset += begun.chunkBytes)
    await files.appendUpload({
      conversationId: "conv",
      uploadId: begun.uploadId,
      offset,
      dataBase64: bytes.subarray(offset, offset + begun.chunkBytes).toString("base64"),
    });
  const committed = await files.commitUpload("conv", begun.uploadId);
  if (committed.status !== "committed") throw new Error("committed expected");
  return (await files.attachment("conv", committed.file.artifactId))!;
}

describe("files to a seat on a linked machine", () => {
  it("places attachments in the remote inbox and names the remote paths", async () => {
    const pc = await machine();
    const attachments = [
      await stored(pc.root, "boss fight?.png", PNG),
      await stored(pc.root, "menu.jpg", JPEG),
    ];
    const delivered = await deliverToFleetSeat({
      fleet,
      shell: pc.shell,
      copy: pc.copy,
      workspace: pc.workspace,
      messageId: "msg-one",
      attachments,
    });
    if (!("note" in delivered)) throw new Error(delivered.undeliverable);
    const inbox = join(pc.workspace, ".clankie", "inbox");
    expect(delivered.directory).toBe(join(inbox, "msg-one"));
    expect((await readdir(delivered.directory)).sort()).toEqual(["boss fight_.png", "menu.jpg"]);
    expect(await readFile(join(delivered.directory, "boss fight_.png"))).toEqual(PNG);
    expect(await readFile(join(delivered.directory, "menu.jpg"))).toEqual(JPEG);
    expect(await readFile(join(inbox, ".gitignore"), "utf8")).toBe(
      "# Owner attachments delivered by Clankie; never commit them.\n*\n",
    );
    expect(delivered.note).toContain(`- boss fight_.png (`);
    expect(delivered.note).toContain(join(delivered.directory, "menu.jpg"));
    expect(delivered.note).not.toContain(tmpdir() + "/clankie-fleet-attachments-");
    // Staging is cleared, and the bytes never rode a command line.
    expect(pc.copied).toEqual([".clankie/attachment-staging/msg-one"]);
    expect(await readdir(join(pc.home, ".clankie", "attachment-staging"))).toEqual([]);
    expect(Math.max(...pc.commands.map((command) => command.length))).toBeLessThan(4_096);
  });

  it("refuses a symlinked inbox or a missing workspace and leaves nothing staged", async () => {
    const pc = await machine();
    const outside = join(pc.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(pc.workspace, ".clankie"));
    const attachments = [await stored(pc.root, "a.png", PNG)];
    const refused = await deliverToFleetSeat({
      fleet,
      shell: pc.shell,
      copy: pc.copy,
      workspace: pc.workspace,
      messageId: "msg-two",
      attachments,
    });
    expect(refused).toEqual({ undeliverable: expect.stringContaining("isn't a plain folder") });
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(join(pc.home, ".clankie", "attachment-staging"))).toEqual([]);

    const missing = await deliverToFleetSeat({
      fleet,
      shell: pc.shell,
      copy: pc.copy,
      workspace: join(pc.root, "gone"),
      messageId: "msg-three",
      attachments,
    });
    expect(missing).toEqual({ undeliverable: "The agent's working directory isn't on that machine." });
    expect(pc.copied).toEqual([".clankie/attachment-staging/msg-two"]);
  });
});

describe("an image from a seat on a linked machine", () => {
  it("returns an image inside the workspace and refuses everything else", async () => {
    const pc = await machine();
    const inbox = join(pc.workspace, ".clankie", "inbox");
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, "shot.png"), PNG);
    await writeFile(join(pc.workspace, "notes.png"), "not an image");
    await writeFile(join(pc.workspace, "huge.png"), Buffer.concat([PNG, Buffer.alloc(3_800_000)]));
    await writeFile(join(pc.root, "secret.png"), PNG);
    await symlink(join(pc.root, "secret.png"), join(pc.workspace, "linked.png"));
    await symlink(pc.root, join(pc.workspace, "up"));
    await mkdir(join(pc.root, "private", "sub"), { recursive: true });
    await writeFile(join(pc.root, "private", "secret.png"), PNG);
    await symlink(join(pc.root, "private", "sub"), join(pc.workspace, "link"));
    const read = (path: string) =>
      readFleetSeatImage({ fleet, shell: pc.shell, workspace: pc.workspace, path });

    for (const path of [".clankie/inbox/shot.png", join(inbox, "shot.png")])
      expect(await read(path)).toEqual({
        outcome: "ready",
        filename: "shot.png",
        mediaType: "image/png",
        byteCount: PNG.byteLength,
        dataBase64: PNG.toString("base64"),
      });
    expect(await read("notes.png")).toEqual({
      outcome: "unavailable",
      message: "notes.png isn't a PNG, JPEG, GIF or WebP image.",
    });
    expect(await read("huge.png")).toMatchObject({
      outcome: "unavailable",
      message: expect.stringContaining("3.8 MB"),
    });
    for (const path of [
      "linked.png",
      "up/secret.png",
      "../../secret.png",
      "link/../secret.png",
      join(pc.root, "secret.png"),
    ])
      expect(await read(path)).toMatchObject({
        outcome: "unavailable",
        message: expect.stringContaining("Only files inside the agent's working directory"),
      });
    expect(await read("missing.png")).toMatchObject({
      outcome: "unavailable",
      message: expect.stringContaining("There's no file at missing.png"),
    });
  });
});
