// Shared by the installed dependency-free bridge and `clankie mcp --seat`.
// The file is an exclusive unresolved claim, never an outgoing replay queue.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = (text) => createHash("sha256").update(text.replace(/\r\n?/gu, "\n").trim()).digest("hex");
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);
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
      // No write attempt until the authenticated service identifies the native
      // session. Older services are readable but cannot supply durable receipts.
      const bindingResponse = await request("");
      const binding = bindingResponse.ok ? (await bindingResponse.json())?.binding : undefined;
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
      const response = await request("", {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, text, delivery: { id: record.deliveryId, binding } }),
      });
      const value = await response.json().catch(() => undefined);
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
      // Even connection errors after a claim are retained. A later invocation
      // only reads the exact original receipt, including after process restart.
      return uncertain(record);
    }
  };
}
