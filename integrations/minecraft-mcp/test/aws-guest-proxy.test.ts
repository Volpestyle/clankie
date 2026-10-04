import { expect, it, vi } from "vitest";
import { GuestPublicProxy } from "../src/aws-guest.ts";
it("keeps the public listener closed until authentication readiness and verifies admission", async () => {
  let authenticated = false;
  const command = vi.fn().mockResolvedValue(undefined);
  const proxy = new GuestPublicProxy(() => authenticated, command);
  expect(await proxy.available()).toBe(false);
  await expect(proxy.open()).rejects.toThrow("authentication readiness");
  expect(command).not.toHaveBeenCalled();
  authenticated = true;
  await proxy.open();
  expect(command.mock.calls.map(([action]) => action)).toEqual(["start", "is-active"]);
  expect(await proxy.available()).toBe(true);
  await proxy.close();
  expect(await proxy.available()).toBe(false);
  expect(command).toHaveBeenLastCalledWith("stop");
});
it("closes an admission that races a host crash and never republishes stale readiness", async () => {
  let authenticated = true;
  let finish: () => void = () => {};
  const starting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const command = vi.fn(async (action: string) => {
    if (action === "start") await starting;
  });
  const proxy = new GuestPublicProxy(() => authenticated, command);
  const opening = proxy.open();
  const rejected = expect(opening).rejects.toThrow("admission failed");
  await Promise.resolve();
  authenticated = false;
  const closing = proxy.close();
  finish();
  await rejected;
  await closing;
  expect(await proxy.available()).toBe(false);
  expect(command).toHaveBeenLastCalledWith("stop");
});
it("does not advertise a proxy that died after admission", async () => {
  const command = vi.fn().mockResolvedValue(undefined);
  const proxy = new GuestPublicProxy(() => true, command);
  await proxy.open();
  command.mockRejectedValueOnce(new Error("inactive"));
  expect(await proxy.available()).toBe(false);
  expect(command).toHaveBeenLastCalledWith("stop");
});
