import { describe, expect, it } from "vitest";
import { fetchActivitySnapshot, fetchRivalsSnapshot } from "../src/go-live-source.ts";

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

it("publishes only bounded PNGs from a read-only Rivals frame capability", async () => {
  const url = `http://127.0.0.1:4330/frame.png?key=${"k".repeat(43)}`;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const frame = await fetchRivalsSnapshot(url, async (_input, options) => {
    expect(options?.redirect).toBe("error");
    expect(options?.headers).toBeUndefined();
    return new Response(png, { headers: { "content-type": "image/png", "content-length": "8" } });
  });
  expect(frame?.data).toBe(png.toString("base64"));
  expect(await fetchRivalsSnapshot(url, async () => new Response("gone", { status: 409 }))).toBeUndefined();
  expect(
    await fetchRivalsSnapshot(
      url,
      async () =>
        new Response(new Uint8Array(9), {
          headers: { "content-type": "image/png", "content-length": "8" },
        }),
    ),
  ).toBeUndefined();
  expect(
    await fetchRivalsSnapshot(url.replace("/frame.png", "/v1/stop"), async () => {
      throw new Error("must not fetch a control endpoint");
    }),
  ).toBeUndefined();
});
