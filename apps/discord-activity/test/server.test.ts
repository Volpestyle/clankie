import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RenderedSurfaceHub } from "../src/frame-hub.ts";
import { createDiscordActivityServer, type DiscordActivityServer } from "../src/server.ts";

const AVATAR = `agent-123e4567-e89b-42d3-a456-426614174000-${"b".repeat(64)}`;

describe("Discord activity avatar host", () => {
  let root: string | undefined;
  let activity: DiscordActivityServer | undefined;

  afterEach(async () => {
    await activity?.close();
    activity = undefined;
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("serves only content-hashed persona PNG paths", async () => {
    root = await mkdtemp(join(tmpdir(), "clankie-avatars-"));
    const avatarDirectory = join(root, "avatars");
    await mkdir(avatarDirectory);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(avatarDirectory, `${AVATAR}.png`), png);
    activity = createDiscordActivityServer({ hub: new RenderedSurfaceHub(), avatarDirectory });
    const port = await activity.listen(0);

    const response = await fetch(`http://127.0.0.1:${String(port)}/avatars/${AVATAR}.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    expect((await fetch(`http://127.0.0.1:${String(port)}/avatars/../personas.json`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${String(port)}/avatars/${"a".repeat(64)}.png`)).status).toBe(404);
  });
});
