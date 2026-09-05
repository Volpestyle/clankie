// Synthetic OpenAI-compatible provider for the VUH-1053 spike. Canned text, no
// network, no credential. It proves the message transport, never model behaviour.
import { createServer } from "node:http";
const REPLY = "Yes - I hear you from inside the Linux container.";
const read = (req) =>
  new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
createServer(async (req, res) => {
  const url = req.url ?? "";
  if (url.endsWith("/models")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ object: "list", data: [{ id: "spike-echo", object: "model" }] }));
  }
  const raw = await read(req);
  // pi asks for a stream in the body, not with an Accept header.
  const wantsStream = (() => {
    try {
      return JSON.parse(raw).stream === true;
    } catch {
      return false;
    }
  })();
  const id = "chatcmpl-spike";
  const created = Math.floor(Date.now() / 1000);
  if (wantsStream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "spike-echo", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: "assistant", content: REPLY }, null));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      id,
      object: "chat.completion",
      created,
      model: "spike-echo",
      choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );
}).listen(18080, "127.0.0.1", () => console.log("synthetic provider on 127.0.0.1:18080"));
