import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { readCodexRateLimits, readCodexHookTrust } from "../src/codex-rate-limits.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function server() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    pid: 123,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      child.emit("exit", 0);
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}
test("quota RPC uses explicit home, no thread/login requests, and returns only normalized limits", async () => {
  const child = server();
  vi.stubEnv("HERDR_PANE_ID", "owner-pane");
  const messages: { method: string }[] = [];
  child.stdin.on("data", (bytes) => {
    const m = JSON.parse(bytes.toString());
    messages.push(m);
    if (m.id === 1) queueMicrotask(() => child.stdout.write('{"id":1,"result":{}}\n'));
    if (m.id === 2)
      queueMicrotask(() =>
        child.stdout.write(
          JSON.stringify({
            id: 2,
            result: {
              rateLimits: { primary: { usedPercent: 99, windowDurationMins: 10080 } },
              rateLimitsByLimitId: {
                codex: {
                  primary: { usedPercent: 92, windowDurationMins: 10080, resetsAt: 12345 },
                  secondary: null,
                  credits: { balance: "private" },
                },
              },
            },
          }) + "\n",
        ),
      );
  });
  const result = await readCodexRateLimits("/fixture/second");
  expect(messages.map((m) => m.method)).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  expect(spawn).toHaveBeenLastCalledWith(
    "codex",
    ["app-server", "--listen", "stdio://"],
    expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: "/fixture/second" }) }),
  );
  expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env).not.toHaveProperty("HERDR_PANE_ID");
  expect(JSON.parse(result!)).toEqual({
    payload: {
      rate_limits: {
        primary: { used_percent: 92, window_minutes: 10080, resets_at: 12345 },
        secondary: null,
      },
    },
  });
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});
test("quota read has a bounded timeout and terminates only its own child", async () => {
  vi.useFakeTimers();
  const child = server();
  const result = readCodexRateLimits("/fixture/offline");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toBeNull();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});
test("unavailable executable returns unknown", async () => {
  const child = server();
  const result = readCodexRateLimits("/fixture/offline");
  child.emit("error", new Error("ENOENT"));
  expect(await result).toBeNull();
});

test.each([
  ["untrusted", "review_required"],
  ["modified", "review_required"],
  ["trusted", "ready"],
  ["managed", "ready"],
  ["future-status", "unknown"],
])("hook diagnostics report %s without accepting trust", async (trustStatus, expected) => {
  const child = server();
  const methods: string[] = [];
  child.stdin.on("data", (bytes) => {
    const m = JSON.parse(bytes.toString());
    methods.push(m.method);
    if (m.id === 1) queueMicrotask(() => child.stdout.write('{"id":1,"result":{}}\n'));
    if (m.id === 2) {
      expect(m.params).toEqual({ cwds: ["/fixture/home"] });
      queueMicrotask(() =>
        child.stdout.write(
          JSON.stringify({
            id: 2,
            result: {
              data: [
                {
                  hooks: [{ enabled: true, trustStatus, command: "private-hook" }],
                  errors: [],
                  warnings: [],
                },
              ],
            },
          }) + "\n",
        ),
      );
    }
  });
  expect(await readCodexHookTrust("/fixture/home")).toBe(expected);
  expect(methods).toEqual(["initialize", "initialized", "hooks/list"]);
});
