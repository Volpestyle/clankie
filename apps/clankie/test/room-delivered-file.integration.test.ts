import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptainChannelTurnResultSchema } from "@clankie/protocol";
import { expect, it } from "vitest";
import {
  ROOM_MEDIA_DROPPED_NOTE,
  roomTurnMedia,
  withMediaNote,
} from "../src/captain/captain-discord-turns.ts";
import { roomKey } from "../src/captain/tools.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";

// The host, the room binding and the settled-result schema are all real; only the
// Discord post itself is out of scope (the bridge resolver re-reads the same bytes).
it("lets a file he delivered in a room ride that room's reply, and never costs the reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-room-delivered-"));
  try {
    const workspace = join(root, "workspace");
    const attachments = join(root, "attachments");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "shortlist.md"), "# Three houses\n");
    const store = new DeliveredFileStore(attachments);
    const room = roomKey("discord_presence", "1052402897645752351:1551975693582336060");
    const published = await store.publish({
      conversationId: room,
      sourceRoot: workspace,
      path: "shortlist.md",
    });
    const media = { artifactRef: published.artifactRef, filename: published.filename };

    // Same room: it rides the reply, and the settled result the receipts store accepts.
    const kept = roomTurnMedia(media, room);
    expect(kept).toEqual({ media });
    const settled = CaptainChannelTurnResultSchema.parse({
      state: "settled",
      captainSessionId: "session",
      turnId: "turn",
      response: "Here's the shortlist.",
      media: kept.media,
    });
    expect(settled.state).toBe("settled");
    // The ref resolves to exactly the bytes the host wrote, as the bridge resolver checks.
    const [, digest, relativePath] = /^sha256:([0-9a-f]{64}):(.+)$/u.exec(published.artifactRef)!;
    const bytes = await readFile(join(attachments, relativePath!));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);

    // Another room's file, or a ref no host minted, is dropped with a note: the words still go out.
    const otherRoom = roomKey("discord_presence", "1052402897645752351:1052402898140667906");
    expect(roomTurnMedia(media, otherRoom)).toEqual({ note: ROOM_MEDIA_DROPPED_NOTE });
    expect(
      roomTurnMedia({ artifactRef: `sha256:${"a".repeat(64)}:notes/x.md`, filename: "x.md" }, room),
    ).toEqual({ note: ROOM_MEDIA_DROPPED_NOTE });
    const reply = withMediaNote("x".repeat(16_384), ROOM_MEDIA_DROPPED_NOTE);
    expect(reply.length).toBe(16_384);
    expect(reply.endsWith(ROOM_MEDIA_DROPPED_NOTE)).toBe(true);
    expect(
      CaptainChannelTurnResultSchema.safeParse({
        state: "settled",
        captainSessionId: "session",
        turnId: "turn",
        response: reply,
      }).success,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
