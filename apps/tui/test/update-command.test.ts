import { expect, it } from "vitest";
import { runUpdateCommand } from "../src/command/update.ts";
it("CLI sends one authenticated update and reads status without mutation", async () => {
  const calls: {
    url: string;
    method?: string | undefined;
    body?: BodyInit | null | undefined;
    bearer: string | null;
  }[] = [];
  const options = {
    env: { CLANKIE_OPERATOR_TOKEN: "fixture" },
    fetchImpl: (async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body,
        bearer: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ accepted: true, runtime: { commit: "b".repeat(40) } }, { status: 202 });
    }) as typeof fetch,
  };
  await runUpdateCommand(["--ref", "main"], options);
  await runUpdateCommand(["status"], options);
  expect(calls).toMatchObject([
    { method: "POST", bearer: "Bearer fixture", body: '{"ref":"main"}' },
    { method: "GET", bearer: "Bearer fixture" },
  ]);
  expect(calls[1]?.body).toBeUndefined();
});
it("lost schedule response is never automatically resent", async () => {
  let calls = 0;
  await expect(
    runUpdateCommand([], {
      env: { CLANKIE_OPERATOR_TOKEN: "fixture" },
      fetchImpl: async () => {
        calls++;
        throw Error("response lost");
      },
    }),
  ).rejects.toThrow("response lost");
  expect(calls).toBe(1);
});
it("CLI refuses extra path/source options and flag-shaped refs", async () => {
  for (const args of [
    ["--runtime", "/owner"],
    ["--ref", "--evil"],
    ["status", "again"],
  ])
    await expect(
      runUpdateCommand(args, {
        env: {},
        fetchImpl: async () => {
          throw Error("must not send");
        },
      }),
    ).rejects.toThrow("Usage");
});
