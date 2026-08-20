import { describe, expect, it } from "vitest";
import { fetchActivitySnapshot } from "../src/go-live-source.ts";

describe("Go Live activity snapshot source", () => {
  it("returns the latest PNG when the producer answers", async () => {
    const frame = await fetchActivitySnapshot(
      {} as NodeJS.ProcessEnv,
      (async (input) => {
        expect(String(input)).toContain("/snapshot");
        return Response.json({
          encoding: "png",
          data: "cG5n",
          sha256: "abc",
        });
      }) as typeof fetch,
      async () => "clankie_activity_producer_test",
    );
    expect(frame).toEqual({
      mimeType: "image/png",
      data: "cG5n",
      sha256: "abc",
    });
  });

  it("returns nothing when no producer token exists", async () => {
    await expect(
      fetchActivitySnapshot({} as NodeJS.ProcessEnv, fetch, async () => undefined),
    ).resolves.toBeUndefined();
  });
});
