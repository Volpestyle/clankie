import { afterEach, expect, test, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LazyMcpClient } from "../src/mcp-client.ts";

afterEach(() => vi.useRealTimers());

test("opens tools lazily, retires idle transports and leaves active calls alone", async () => {
  vi.useFakeTimers();
  const closes: ReturnType<typeof vi.fn>[] = [];
  const connect = vi.fn(async () => {
    const close = vi.fn(async () => {});
    closes.push(close);
    return { transport: {}, close } as unknown as Client;
  });
  const client = new LazyMcpClient(connect, 100);
  expect(connect).not.toHaveBeenCalled();
  let finish!: () => void;
  const running = client.use(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(200);
  expect(closes[0]).not.toHaveBeenCalled();
  finish();
  await running;
  await vi.advanceTimersByTimeAsync(100);
  expect(closes[0]).toHaveBeenCalledOnce();
  await client.use(async () => {});
  expect(connect).toHaveBeenCalledTimes(2);
  await client.close();
  expect(closes[1]).toHaveBeenCalledOnce();
  await expect(client.use(async () => {})).rejects.toThrow("closed");
});

test("shares concurrent connection setup and never retries a failed mutation", async () => {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ transport: {}, close }) as unknown as Client);
  const client = new LazyMcpClient(connect);
  const mutation = vi.fn(async () => {
    throw new Error("response lost");
  });
  try {
    await Promise.all([client.use(async () => {}), client.use(async () => {})]);
    expect(connect).toHaveBeenCalledOnce();
    await expect(client.use(mutation)).rejects.toThrow("response lost");
    expect(mutation).toHaveBeenCalledOnce();
  } finally {
    await client.close();
  }
});
