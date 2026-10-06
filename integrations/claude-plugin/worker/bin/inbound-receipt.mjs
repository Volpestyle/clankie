// Shared by the installed dependency-free bridge and `clankie mcp --seat`.
// The file is an exclusive unresolved claim, never an outgoing replay queue.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

export function createInboundSender({ directory, scope, request, onObservation, now = Date.now }) {
  let lastStoredAt;
  const observed = (receipt, reason) => {
    const observedAt = new Date(now()).toISOString();
    if (receipt.deliveryStage === "stored") lastStoredAt = observedAt;
    const observation = {
      outcome: reason === "stored" ? "stored" : receipt.deliveryStage,
      reason,
      observedAt,
      ...(lastStoredAt === undefined ? {} : { lastStoredAt }),
    };
    try {
      void Promise.resolve(onObservation?.(observation)).catch(() => {});
    } catch {
      /* Health observation never changes receipt semantics. */
    }
    return receipt;
  };
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
  try {
    if (inspect()) {
      const observedAt = statSync(path).mtime.toISOString();
      void Promise.resolve(
        onObservation?.({ outcome: "uncertain", reason: "receipt_unresolved", observedAt }),
      ).catch(() => {});
    }
  } catch {
    observed(uncertain(), "local_receipt_unavailable");
  }
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
      return observed(
        { ...value, detail: "The original was not sent. No replacement was sent." },
        "receipt_unresolved",
      );
    }
    if (!stored(value, record))
      return observed(uncertain(record), response.ok ? "receipt_invalid" : "receipt_unresolved");
    // Only unlink this exact claim. Another process may have reconciled it;
    // never remove a newer original that took its place.
    settle(record);
    lastStoredAt = new Date(now()).toISOString();
    return observed(
      hash(text) === record.fingerprint
        ? value
        : {
            received: false,
            deliveryStage: "unavailable",
            detail: "The original message is stored. This different follow-up was not sent.",
          },
      "stored",
    );
  };
  const send = async (text) => {
    let record;
    let phase = "local";
    try {
      record = inspect();
      if (record) {
        phase = "receipt";
        return await reconcile(record, text);
      }
      // No write attempt until the authenticated service identifies the native
      // session. Older services are readable but cannot supply durable receipts.
      phase = "binding";
      const bindingResponse = await request("");
      const binding = bindingResponse.ok ? (await bindingResponse.json())?.binding : undefined;
      if (!hex(binding))
        return observed(
          {
            received: false,
            deliveryStage: [400, 401, 403, 413].includes(bindingResponse.status) ? "rejected" : "unavailable",
            detail: "No durable native binding is available; nothing was sent.",
          },
          [400, 401, 403, 413].includes(bindingResponse.status) ? "binding_rejected" : "binding_unavailable",
        );
      phase = "local";
      record = { schemaVersion: 1, deliveryId: randomUUID(), binding, fingerprint: hash(text), text };
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        // Exclusive creation fences concurrent bridges before the first POST.
        mutate(() => writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }));
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const original = inspect();
        phase = "receipt";
        return original
          ? await reconcile(original, text)
          : observed(uncertain(), "local_receipt_unavailable");
      }
      let response;
      phase = "receipt";
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
        return observed(
          {
            schemaVersion: 1,
            received: false,
            deliveryStage: "unavailable",
            deliveryId: record.deliveryId,
            binding: record.binding,
            fingerprint: record.fingerprint,
            detail: "The connection was refused before dispatch; nothing was sent.",
          },
          "connection_refused",
        );
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
      if (!(response.ok && stored(value, record)) && !exactRefusal)
        return observed(uncertain(record), response.ok ? "receipt_invalid" : "receipt_unresolved");
      settle(record);
      return observed(value, value.deliveryStage === "stored" ? "stored" : "receipt_unresolved");
    } catch (error) {
      // A timeout, reset, lost reply, or failed receipt read retains the claim.
      // A later invocation only reads the exact original receipt.
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      return observed(
        uncertain(record),
        phase === "binding"
          ? timeout
            ? "binding_timeout"
            : "binding_unavailable"
          : phase === "receipt"
            ? timeout
              ? "receipt_timeout"
              : "receipt_unresolved"
            : "local_receipt_unavailable",
      );
    }
  };
  // A refreshed bridge settles the retained original by GET only. Never call
  // send with a placeholder: an empty journal must not create a new intent.
  return Object.assign(send, {
    async reconcilePending() {
      let record;
      try {
        record = inspect();
        return record === undefined ? undefined : await reconcile(record, record.text);
      } catch {
        return uncertain(record);
      }
    },
  });
}
