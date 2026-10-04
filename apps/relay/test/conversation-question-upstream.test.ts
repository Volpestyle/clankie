import { afterEach, expect, it, vi } from "vitest";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
  DeviceConversationRefusal,
  type DeviceConversationRequest,
} from "../src/conversation-upstream.ts";

const request = { op: "input_get", schemaVersion: 1, conversationId: "workspace-test" } as const;
const result = {
  op: "input_get",
  schemaVersion: 1,
  result: { status: "ready", conversationId: "workspace-test" },
};
const token = "signed-device-fixture-token";
afterEach(() => vi.restoreAllMocks());

it.each([undefined, "hosted"] as const)(
  "forwards original device identity with scope %s, exactly once",
  async (controlScope) => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        `http://control.test${controlScope ? "/v1/hosted/operator" : "/operator/v1/dispatch"}`,
      );
      expect(init?.headers).toEqual({ authorization: `Bearer ${token}`, "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual(
        controlScope
          ? {
              method: "POST",
              path: "/operator/v1/dispatch",
              body: JSON.stringify(request),
            }
          : request,
      );
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      return Response.json(result);
    });
    const dispatch = createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher });
    expect(
      await dispatch(request, { deviceToken: token, ...(controlScope ? { controlScope } : {}) }),
    ).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([400, 401, 403, 404, 409, 429, 503])(
  "preserves only safe HTTP %i, never refusal content or a fallback",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(`Bearer ${token} private answer`, { status }),
    );
    const dispatch = createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher });
    const failure = await dispatch(request, { deviceToken: token, controlScope: "hosted" }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(DeviceConversationRefusal);
    expect(failure).toMatchObject({ status, message: "Conversation owner upstream refused" });
    expect(String(failure)).not.toContain(token);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([
  () => new Response("bad JSON"),
  () => Response.json({ ...result, schemaVersion: 2, extra: "optional" }),
  () => Response.json({ ...result, op: "input_cancel" }),
  () => new Response("Bearer secret", { status: 500 }),
  () => new Response(null, { status: 302, headers: { location: "https://other.test" } }),
])("refuses corrupt/redirected/unexpected upstream results without retry", async (response) => {
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const dispatch = createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher });
  await expect(dispatch(request, { deviceToken: token })).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(["device", "captain"] as const)(
  "projects additive upstream response fields in the %s hop",
  async (kind) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ...result, extra: true, result: { ...result.result, extra: { optional: true } } }),
    );
    const actual =
      kind === "device"
        ? await createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher })(
            request,
            { deviceToken: token },
          )
        : await createCaptainConversationDispatch({
            baseUrl: "http://control.test",
            fetch: fetcher,
            bearerToken: "fixture-captain-token",
          })(request);
    expect(actual).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([
  "http://u:p@control.test",
  "http://control.test/h/host",
  "http://control.test?token=x",
  "http://control.test#x",
  "file:///tmp/control",
])("rejects unsupported control origin %s before any fetch", (baseUrl) => {
  const fetcher = vi.fn<typeof fetch>();
  expect(() => createDeviceConversationDispatch({ baseUrl, fetch: fetcher })).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("refuses operations outside the narrow signed-device hop", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const dispatch = createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher });
  await expect(
    dispatch({ op: "reset" } as unknown as DeviceConversationRequest, { deviceToken: token }),
  ).rejects.toThrow("Unsupported");
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["owner", "captain"])(
  "carries caller abort and a finite deadline through %s unary fetch",
  async (kind) => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    });
    const caller = new AbortController();
    const dispatch =
      kind === "owner"
        ? () =>
            createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher })(
              request,
              { deviceToken: token },
              caller.signal,
            )
        : () =>
            createCaptainConversationDispatch({
              baseUrl: "http://captain.test",
              bearerToken: "captain-fixture-token",
              fetch: fetcher,
            })(request, caller.signal);
    const pending = dispatch();
    const rejection = expect(pending).rejects.toThrow("aborted");
    await began;
    caller.abort();
    await rejection;
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("expires owner work at the finite deadline and does not retry", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetcher = vi.fn<typeof fetch>(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        queueMicrotask(() => deadline.abort());
      }),
  );
  const dispatch = createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher });
  await expect(dispatch(request, { deviceToken: token })).rejects.toThrow("deadline");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("aborted admission never starts the owner network request", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const dispatch = createDeviceConversationDispatch({ baseUrl: "http://control.test", fetch: fetcher });
  await expect(dispatch(request, { deviceToken: token }, AbortSignal.abort())).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
