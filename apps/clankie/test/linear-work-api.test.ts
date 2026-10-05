import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

it("retires the Linear inbox/read/ack/handoff and per-conversation work-routing HTTP surfaces", async () => {
  const { app, close } = await createClankieApp({ captain: createStubCaptain() });
  try {
    for (const [path, methods] of [
      ["/v1/linear/inbox", ["GET", "POST"]],
      ["/v1/linear/inbox/handoff", ["POST"]],
      ["/v1/linear/work", ["GET", "PUT", "DELETE"]],
    ] as const)
      for (const method of methods) expect((await app.request(path, { method })).status).toBe(404);
  } finally {
    close();
  }
});
