// Shared by the installed dependency-free bridge and `clankie mcp --seat`.
// The file is an exclusive unresolved claim, never an outgoing replay queue.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admissionRefusal, checkFleetMembership } from "./admission.mjs";

const hash = (text) => createHash("sha256").update(text.replace(/\r\n?/gu, "\n").trim()).digest("hex");
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);
/** Read-only recovery guard. A corrupt claim or abandoned lock remains held. */
export function hasPendingInboundClaim(directory, scope) {
  const path = join(directory, `${hash(scope)}.json`);
  for (const candidate of [path, `${path}.lock`]) {
    try {
      statSync(candidate);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") return true;
    }
  }
  return false;
}
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
  // A recovered original has a short, durable reconciliation window, separate
  // from its unresolved claim. Ordinary successful sends do not open one.
  const storedDirectory = join(directory, `${hash(scope)}.stored`);
  const storedPath = join(storedDirectory, "reconcile.json");
  const RECONCILE_WINDOW_MS = 5 * 60_000;
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
  const inspectStored = (record) => {
    try {
      const window = JSON.parse(readFileSync(storedPath, "utf8"));
      const value = window.receipt;
      if (
        !Number.isFinite(window.expiresAt) ||
        !uuid(value?.deliveryId) ||
        !hex(value.binding) ||
        !hex(value.fingerprint) ||
        !stored(value, value)
      )
        throw new Error("Unreadable settled reconciliation receipt");
      if (
        window.expiresAt <= now() ||
        value.binding !== record.binding ||
        value.fingerprint !== record.fingerprint
      )
        return undefined;
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  };
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
  const settle = (record, receipt, reconciled = false) =>
    mutate(() => {
      // A delayed GET cannot reopen an older reconciliation window after a
      // newer original has acquired or already released this pane's claim.
      if (inspect()?.deliveryId !== record.deliveryId) return;
      if (reconciled && stored(receipt, record)) {
        // Retain the exact authenticated positive before releasing its claim.
        // A failed window write leaves the original fenced for GET recovery.
        mkdirSync(storedDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(
          storedPath,
          `${JSON.stringify({ receipt, expiresAt: now() + RECONCILE_WINDOW_MS })}\n`,
          { mode: 0o600 },
        );
      }
      unlinkSync(path);
    });
  const reconcile = async (record, text) => {
    const query = new URLSearchParams({ binding: record.binding, fingerprint: record.fingerprint });
    const response = await request(`/${record.deliveryId}?${query}`);
    try {
      await checkFleetMembership(response);
    } catch (error) {
      return observed(
        uncertain(
          record,
          `${error.message} The original receipt remains unresolved; reconcile it after admission is restored, do not resend.`,
        ),
        "receipt_unresolved",
      );
    }
    if (await admissionRefusal(response))
      return observed(
        uncertain(
          record,
          "Fleet admission could not be verified just now. Wait briefly and reconcile this original receipt again; do not resend the message.",
        ),
        "receipt_unresolved",
      );
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
      // This call only settled the earlier original; its own text was not sent
      // either. Say so, or a worker reads its new message as refused (VUH-2244).
      return observed(
        {
          ...value,
          detail:
            hash(text) === record.fingerprint
              ? `Your earlier message ${record.deliveryId} was not sent, and this call sent nothing. Send it again with a new message_clankie call.`
              : `This call only settled your earlier message ${record.deliveryId}, which was not sent; this message was not sent either. Send this message again with a new message_clankie call.`,
        },
        "receipt_unresolved",
      );
    }
    if (!stored(value, record))
      return observed(uncertain(record), response.ok ? "receipt_invalid" : "receipt_unresolved");
    // Only unlink this exact claim. Another process may have reconciled it;
    // never remove a newer original that took its place.
    settle(record, value, true);
    lastStoredAt = new Date(now()).toISOString();
    return observed(
      hash(text) === record.fingerprint
        ? value
        : {
            received: false,
            deliveryStage: "unavailable",
            deliveryId: record.deliveryId,
            detail:
              "The original message is stored. This different follow-up was not sent. Call again with the distinct follow-up if still needed; do not resend the original.",
          },
      "stored",
    );
  };
  const send = async (text, options) => {
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
      const bindingRefusal = await admissionRefusal(bindingResponse);
      if (bindingRefusal)
        return observed(
          { received: false, deliveryStage: "unavailable", ...bindingRefusal },
          "binding_unavailable",
        );
      const binding = bindingResponse.ok ? (await bindingResponse.json())?.binding : undefined;
      if (!hex(binding))
        return observed(
          {
            received: false,
            deliveryStage: [400, 401, 403, 413].includes(bindingResponse.status) ? "rejected" : "unavailable",
            detail: [401, 403].includes(bindingResponse.status)
              ? "The service refused this native seat. Ask Clankie to confirm fleet admission; repeated retries cannot grant access. Nothing was sent."
              : "No durable native binding is available; nothing was sent.",
          },
          [400, 401, 403, 413].includes(bindingResponse.status) ? "binding_rejected" : "binding_unavailable",
        );
      phase = "local";
      record = { schemaVersion: 1, deliveryId: randomUUID(), binding, fingerprint: hash(text), text };
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        // Exclusive creation fences concurrent bridges before the first POST.
        const previous = mutate(() => {
          // Recheck under the same claim lock: another bridge may have settled
          // this payload after our binding lookup and before exclusive creation.
          const retained = inspectStored(record);
          if (retained) return retained;
          writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
          // Fresh intent closes the recovered original's matching window.
          // Receipt reconciliation itself never allocates or sends that intent.
          try {
            unlinkSync(storedPath);
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        });
        if (previous) return observed(previous, "stored");
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
          body: JSON.stringify({
            schemaVersion: 1,
            text,
            delivery: { id: record.deliveryId, binding },
            // A delivery hint only: it is not part of the original's fingerprint (VUH-2274).
            ...(options?.urgent === true ? { urgent: true } : {}),
          }),
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
      try {
        await checkFleetMembership(response);
      } catch (error) {
        settle(record);
        return observed(
          { received: false, deliveryStage: "rejected", detail: `${error.message} Nothing was sent.` },
          "binding_rejected",
        );
      }
      const refusal = await admissionRefusal(response);
      if (refusal) {
        // This authenticated contract is emitted before forwarding, so the
        // original was never dispatched. It must not strand an uncertain claim.
        settle(record);
        return observed({ received: false, deliveryStage: "unavailable", ...refusal }, "binding_unavailable");
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
      settle(record, value);
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
      } catch (error) {
        const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
        return observed(
          uncertain(record),
          record ? (timeout ? "receipt_timeout" : "receipt_unresolved") : "local_receipt_unavailable",
        );
      }
    },
  });
}
