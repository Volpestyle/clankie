import { describe, expect, it } from "vitest";
import { coalesceOnce, runShutdownSteps } from "../src/shutdown.ts";

describe("shutdown helpers", () => {
  it("runs every step and rethrows the first failure", async () => {
    const order: string[] = [];
    await expect(
      runShutdownSteps([
        () => {
          order.push("a");
        },
        () => {
          order.push("b");
          throw new Error("first");
        },
        () => {
          order.push("c");
          throw new Error("second");
        },
      ]),
    ).rejects.toThrow("first");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("collapses concurrent signals onto one run", async () => {
    let runs = 0;
    const shutdown = coalesceOnce(async () => {
      runs += 1;
    });
    await Promise.all([shutdown("SIGINT"), shutdown("SIGTERM")]);
    expect(runs).toBe(1);
  });
});
