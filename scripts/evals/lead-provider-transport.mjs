/** Final physical HTTP admission. No request is made at import or construction. */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { zstdDecompressSync } from "node:zlib";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_REQUEST = 4 * 1024 * 1024;
const MAX_EVENT = 4 * 1024 * 1024;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export function createLeadTransport({
  model,
  effort,
  accountId,
  selectedCredential,
  admit,
  assertCurrent,
  signal,
  tools,
  stop,
  fetch: transport = globalThis.fetch,
}) {
  if (
    !model ||
    !accountId ||
    effort !== "medium" ||
    typeof assertCurrent !== "function" ||
    !(signal instanceof AbortSignal) ||
    (tools !== undefined && !Array.isArray(tools))
  )
    throw Error("Fixed lead model/account/medium policy required");
  let pinnedTools = tools === undefined ? undefined : structuredClone(tools);
  const events = [];
  const controllers = new Set();
  let stopped;
  let sequence = 0;
  let tail = "0".repeat(64);
  const record = (type, data) => {
    const event = { sequence: ++sequence, previous: tail, type, ...data };
    tail = digest(JSON.stringify(event));
    events.push({ ...event, sha256: tail });
  };
  const fail = async (reason) => {
    if (!stopped) {
      for (const controller of controllers) controller.abort();
      stopped = Promise.resolve()
        .then(() => stop(reason))
        .catch((error) => {
          record("stop-failed", {});
          throw error;
        });
    }
    await stopped;
    throw Error(`Lead transport stopped: ${reason}`);
  };
  signal.addEventListener(
    "abort",
    () => {
      void fail("shared run admission revoked").catch(() => {});
    },
    { once: true },
  );
  const pending = new Set();
  const fetch = async (url, init) => {
    let id;
    try {
      if (!pinnedTools) throw Error("Controller tool schemas not bound");
      if (stopped || signal.aborted) return await fail("stop latched");
      if (
        url !== "https://chatgpt.com/backend-api/codex/responses" ||
        init?.method !== "POST" ||
        (init.redirect !== undefined && init.redirect !== "error")
      )
        throw Error("Unexpected final provider endpoint/method");
      const headers = new Headers(init.headers);
      const headerNames = [
        "authorization",
        "chatgpt-account-id",
        "originator",
        "user-agent",
        "openai-beta",
        "accept",
        "content-type",
        "content-encoding",
      ];
      if (
        [...headers.keys()].some((key) => !headerNames.includes(key)) ||
        headers.get("originator") !== "pi" ||
        headers.get("openai-beta") !== "responses=experimental" ||
        headers.get("accept") !== "text/event-stream" ||
        headers.get("content-type") !== "application/json" ||
        !headers.get("user-agent") ||
        headers.get("user-agent").length > 512
      )
        throw Error("Unexpected final provider header policy");
      const encoding = headers.get("content-encoding");
      if (encoding !== null && encoding !== "zstd") throw Error("Unknown provider request encoding");
      if (!(typeof init.body === "string" || init.body instanceof Uint8Array))
        throw Error("Unknown provider body representation");
      let bytes = Buffer.from(init.body);
      if (bytes.length > MAX_REQUEST) throw Error("Provider request exceeds bound");
      if (encoding === "zstd") bytes = zstdDecompressSync(bytes, { maxOutputLength: MAX_REQUEST });
      if (bytes.length > MAX_REQUEST) throw Error("Decoded provider request exceeds bound");
      const body = JSON.parse(bytes.toString("utf8"));
      const keys = [
        "model",
        "store",
        "stream",
        "instructions",
        "input",
        "text",
        "include",
        "tool_choice",
        "parallel_tool_calls",
        "tools",
        "reasoning",
      ];
      if (
        Object.keys(body).some((key) => !keys.includes(key)) ||
        body.model !== model ||
        body.store !== false ||
        body.stream !== true ||
        body.reasoning?.effort !== effort ||
        typeof body.instructions !== "string" ||
        !Array.isArray(body.input) ||
        body.tool_choice !== "auto" ||
        body.parallel_tool_calls !== true ||
        body.text?.verbosity !== "low" ||
        JSON.stringify(body.include) !== '["reasoning.encrypted_content"]'
      )
        throw Error("Final provider policy mismatch");
      const only = (value, keys) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) => keys.includes(key));
      const content = (value) =>
        typeof value === "string" ||
        (Array.isArray(value) &&
          value.every(
            (part) =>
              only(part, ["type", "text", "annotations"]) &&
              ["input_text", "output_text"].includes(part.type) &&
              typeof part.text === "string" &&
              (part.annotations === undefined ||
                (Array.isArray(part.annotations) && part.annotations.length === 0)),
          ));
      if (
        !only(body.reasoning, ["effort", "summary"]) ||
        body.reasoning.summary !== "auto" ||
        !only(body.text, ["verbosity"])
      )
        throw Error("Unknown final reasoning/text policy");
      for (const item of body.input) {
        let valid = false;
        if (item?.type === undefined || item.type === "message")
          valid =
            only(item, ["type", "role", "content", "status", "id", "phase"]) &&
            ["user", "assistant", "developer", "system"].includes(item.role) &&
            content(item.content) &&
            (item.status === undefined || item.status === "completed");
        else if (item.type === "function_call")
          valid =
            only(item, ["type", "id", "call_id", "name", "arguments"]) &&
            typeof item.call_id === "string" &&
            typeof item.arguments === "string" &&
            ["read", "edit", "write", "bash", "hire_agent", "message_seat", "herdr_watch"].includes(
              item.name,
            );
        else if (item.type === "function_call_output")
          valid =
            only(item, ["type", "call_id", "output"]) &&
            typeof item.call_id === "string" &&
            content(item.output);
        else if (item.type === "reasoning")
          valid =
            only(item, ["type", "id", "summary", "encrypted_content", "status"]) &&
            typeof item.id === "string" &&
            typeof item.encrypted_content === "string" &&
            Array.isArray(item.summary) &&
            item.summary.every(
              (part) =>
                only(part, ["type", "text"]) && part.type === "summary_text" && typeof part.text === "string",
            );
        if (!valid) throw Error("Unknown/non-text lead transcript item");
      }
      if (
        body.tools?.some(
          (tool) =>
            tool.type !== "function" ||
            !["read", "edit", "write", "bash", "hire_agent", "message_seat", "herdr_watch"].includes(
              tool.name,
            ),
        )
      )
        throw Error("Uncontained provider tool advertised");
      if (!isDeepStrictEqual(body.tools ?? [], pinnedTools) && !isDeepStrictEqual(body.tools ?? [], []))
        throw Error("Contained tool schema changed");
      // This callback must bind a protected native auth record to the exact trusted
      // native account observer. Decoded JWT/account labels are not authority.
      const before = await selectedCredential();
      if (
        before.accountId !== accountId ||
        !before.bindingSha256 ||
        headers.get("authorization") !== `Bearer ${before.accessToken}` ||
        headers.get("chatgpt-account-id") !== accountId ||
        headers.has("x-api-key") ||
        headers.has("api-key")
      )
        throw Error("Final provider credential/account mismatch");
      await admit();
      const after = await selectedCredential();
      if (
        after.bindingSha256 !== before.bindingSha256 ||
        after.accessToken !== before.accessToken ||
        after.accountId !== accountId
      )
        throw Error("Selected native credential changed before request");
      if (init.signal?.aborted || signal.aborted || stopped)
        throw Error("Lead provider request aborted before dispatch");
      assertCurrent();
      id = randomUUID();
      pending.add(id);
      record("request", {
        id,
        accountId,
        model,
        effort,
        payloadSha256: digest(bytes),
        bindingSha256: before.bindingSha256,
      });
      const abort = new AbortController();
      controllers.add(abort);
      const requestSignal = AbortSignal.any([signal, abort.signal, ...(init.signal ? [init.signal] : [])]);
      const response = await transport(url, { ...init, signal: requestSignal, redirect: "error" });
      if (
        !response.ok ||
        response.redirected ||
        !response.body ||
        !response.headers.get("content-type")?.startsWith("text/event-stream")
      )
        throw Error("Provider stream unavailable or redirected");
      let buffer = "",
        completed = false;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parse = (last = false) => {
        if (Buffer.byteLength(buffer) > MAX_EVENT) throw Error("Provider event exceeds bound");
        buffer = buffer.replaceAll("\r\n", "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data);
          if (["response.completed", "response.done"].includes(event.type)) {
            if (completed || event.response?.status !== "completed")
              throw Error("Ambiguous provider completion");
            const usage = event.response.usage;
            if (
              !usage ||
              ![
                usage.input_tokens,
                usage.output_tokens,
                usage.total_tokens,
                usage.input_tokens_details?.cached_tokens,
                usage.output_tokens_details?.reasoning_tokens,
              ].every(integer) ||
              usage.total_tokens !== usage.input_tokens + usage.output_tokens ||
              usage.input_tokens_details.cached_tokens > usage.input_tokens ||
              usage.output_tokens_details.reasoning_tokens > usage.output_tokens
            )
              throw Error("Provider token coverage incomplete");
            if (completed) throw Error("Duplicate terminal usage event");
            record("usage", { id, accountId, usage });
            completed = true;
          }
          if (["error", "response.failed", "response.incomplete"].includes(event.type))
            throw Error("Provider execution incomplete");
        }
        if (last && (buffer.trim() || !completed)) throw Error("Provider closed without complete usage");
      };
      const reader = response.body.getReader();
      const guarded = new ReadableStream({
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              parse(true);
              await admit();
              pending.delete(id);
              controllers.delete(abort);
              record("settled", { id, accountId });
              controller.close();
            } else {
              buffer += decoder.decode(value, { stream: true });
              parse();
              await admit();
              controller.enqueue(value);
            }
          } catch {
            await fail("provider stream lost or trusted accounting/admission failed");
          }
        },
        async cancel() {
          abort.abort();
          await reader.cancel();
          await fail("provider stream consumer cancelled");
        },
      });
      return new Response(guarded, { status: response.status, headers: response.headers });
    } catch {
      if (id) record("uncertain", { id, accountId });
      return fail("physical provider request refused or lost");
    }
  };
  return {
    bindTools(schemas) {
      if (!Array.isArray(schemas) || (pinnedTools && !isDeepStrictEqual(pinnedTools, schemas)))
        throw Error("Controller tool schemas cannot change");
      pinnedTools ??= structuredClone(schemas);
    },
    fetch,
    fail,
    result: () => ({
      complete: !stopped && pending.size === 0 && events.some((event) => event.type === "usage"),
      usageComplete:
        pending.size === 0 &&
        events.some((event) => event.type === "usage") &&
        !events.some((event) => event.type === "uncertain"),
      events: structuredClone(events),
      pending: [...pending],
      lastHash: tail,
    }),
  };
}
