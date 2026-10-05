// Shared by the installed dependency-free bridge and `clankie mcp --seat`.
// The file is an exclusive unresolved claim, never an outgoing replay queue.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = (text) => createHash("sha256").update(text.replace(/\r\n?/gu, "\n").trim()).digest("hex");
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);
/** Only refused connection attempts prove that the POST never reached a service. */
function refusedConnection(error, ancestors = new Set()) {
  if (!error || typeof error !== "object" || ancestors.has(error)) return false;
  const path = new Set(ancestors).add(error);
  const children = [
    ...(error.cause === undefined ? [] : [error.cause]),
    ...(Array.isArray(error.errors) ? error.errors : []),
  ];
  return children.length
    ? (error.code === undefined || error.code === "ECONNREFUSED") &&
        children.every((child) => refusedConnection(child, path))
    : error.code === "ECONNREFUSED";
}
const valid = (value) =>
  value?.schemaVersion === 1 &&
  uuid(value.deliveryId) &&
  hex(value.binding) &&
  hex(value.fingerprint) &&
  typeof value.text === "string" &&
  hash(value.text) === value.fingerprint;

export function createInboundSender({ directory, scope, request }) {
  const path = join(directory, `${hash(scope)}.json`);
  const uncertain = (record, detail = "The original receipt is unresolved; no replacement was sent.") => ({
    received: false,
    deliveryStage: "uncertain",
    detail,
    ...(record
      ? { deliveryId: record.deliveryId, binding: record.binding, fingerprint: record.fingerprint }
      : {}),
  });
  const stored = (value, record) =>
    value?.schemaVersion === 1 &&
    value.received === true &&
    value.deliveryStage === "stored" &&
    value.deliveryId === record.deliveryId &&
    value.binding === record.binding &&
    value.fingerprint === record.fingerprint;
  const inspect = () => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!valid(value)) throw new Error("Unreadable original receipt");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const mutate = (fn) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Tiny synchronous mutation lock: a crash leaves it blocked, never assumes
    // that an old process died or steals its ownership based on elapsed time.
    writeFileSync(`${path}.lock`, "exclusive\n", { flag: "wx", mode: 0o600 });
    try {
      return fn();
    } finally {
      unlinkSync(`${path}.lock`);
    }
  };
  const settle = (record) =>
    mutate(() => {
      if (inspect()?.deliveryId === record.deliveryId) unlinkSync(path);
    });
  const reconcile = async (record, text) => {
    const query = new URLSearchParams({ binding: record.binding, fingerprint: record.fingerprint });
    const response = await request(`/${record.deliveryId}?${query}`);
    const value = response.ok ? await response.json() : undefined;
    if (
      value?.schemaVersion === 1 &&
      value.received === false &&
      value.deliveryStage === "unavailable" &&
      value.definitive === "not_sent" &&
      value.deliveryId === record.deliveryId &&
      value.binding === record.binding &&
      value.fingerprint === record.fingerprint
    ) {
      // Only an authenticated exact terminal negative releases an unknown
      // original. This invocation still cannot send a replacement payload.
      settle(record);
      return { ...value, detail: "The original was not sent. No replacement was sent." };
    }
    if (!stored(value, record)) return uncertain(record);
    // Only unlink this exact claim. Another process may have reconciled it;
    // never remove a newer original that took its place.
    settle(record);
    return hash(text) === record.fingerprint
      ? value
      : {
          received: false,
          deliveryStage: "unavailable",
          detail: "The original message is stored. This different follow-up was not sent.",
        };
  };
  return async (text) => {
    let record;
    try {
      record = inspect();
      if (record) return await reconcile(record, text);
      if (existsSync(`${path}.lock`)) return uncertain();
      // No write attempt until the authenticated service identifies the native
      // session. Older services are readable but cannot supply durable receipts.
      let bindingResponse;
      let binding;
      try {
        bindingResponse = await request("");
        binding = bindingResponse.ok ? (await bindingResponse.json())?.binding : undefined;
      } catch (error) {
        // A concurrent bridge may have claimed an original during discovery.
        // Its state still fences this invocation, including orphaned locks.
        record = inspect();
        if (record || existsSync(`${path}.lock`)) return uncertain(record);
        const reason =
          error?.name === "AbortError" || error?.name === "TimeoutError"
            ? "Binding discovery timed out or was interrupted"
            : refusedConnection(error)
              ? "Binding discovery connection was refused"
              : error instanceof SyntaxError
                ? "Binding discovery returned an invalid response"
                : "Binding discovery transport failed";
        return { received: false, deliveryStage: "unavailable", detail: `${reason}; nothing was sent.` };
      }
      if (!hex(binding))
        return {
          received: false,
          deliveryStage: [400, 401, 403, 413].includes(bindingResponse.status) ? "rejected" : "unavailable",
          detail: "No durable native binding is available; nothing was sent.",
        };
      record = { schemaVersion: 1, deliveryId: randomUUID(), binding, fingerprint: hash(text), text };
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        // Exclusive creation fences concurrent bridges before the first POST.
        mutate(() => writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }));
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const original = inspect();
        return original ? await reconcile(original, text) : uncertain();
      }
      let response;
      try {
        response = await request("", {
          method: "POST",
          // A redirect could follow an accepted original with another failed
          // connection. Never let fetch silently dispatch a second POST.
          redirect: "error",
          body: JSON.stringify({ schemaVersion: 1, text, delivery: { id: record.deliveryId, binding } }),
        });
      } catch (error) {
        if (!refusedConnection(error)) throw error;
        settle(record);
        return {
          schemaVersion: 1,
          received: false,
          deliveryStage: "unavailable",
          deliveryId: record.deliveryId,
          binding: record.binding,
          fingerprint: record.fingerprint,
          detail: "The connection was refused before dispatch; nothing was sent.",
        };
      }
      // An unauthenticated error response is never an exact receipt proof.
      const value = response.ok ? await response.json().catch(() => undefined) : undefined;
      const exactRefusal =
        value?.schemaVersion === 1 &&
        value.received === false &&
        ["rejected", "unavailable"].includes(value.deliveryStage) &&
        value.deliveryId === record.deliveryId &&
        value.binding === record.binding &&
        value.fingerprint === record.fingerprint;
      if (!(response.ok && stored(value, record)) && !exactRefusal) return uncertain(record);
      settle(record);
      return value;
    } catch {
      // A timeout, reset, lost reply, or failed receipt read retains the claim.
      // A later invocation only reads the exact original receipt.
      return uncertain(record);
    }
  };
}
