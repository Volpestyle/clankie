// A fleet peer send owns one durable unresolved claim per sender pane. The
// claim is never a replay queue: later calls can only inspect its exact receipt.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const normalize = (text) => text.replace(/\r\n?/gu, "\n").trim();
const hash = (text) => createHash("sha256").update(text).digest("hex");
const fingerprint = (seatId, binding, text) => hash(JSON.stringify([seatId, binding, normalize(text)]));
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
const seat = (value) =>
  typeof value?.seatId === "string" &&
  value.seatId.length > 0 &&
  value.seatId.length <= 200 &&
  typeof value.paneId === "string" &&
  value.paneId.length > 0 &&
  value.paneId.length <= 200 &&
  hex(value.binding);

/** Discovery is only a description; the service rechecks authority on every write. */
export function readPeerCatalog(value) {
  return value?.schemaVersion === 1 &&
    typeof value.fleet === "string" &&
    value.fleet.length > 0 &&
    seat(value.sender) &&
    Array.isArray(value.seats) &&
    value.seats.length <= 4096 &&
    value.seats.every(
      (entry) => seat(entry) && typeof entry.harness === "string" && typeof entry.title === "string",
    )
    ? value
    : undefined;
}

export function createPeerSender({ directory, scope, discover, request }) {
  const path = join(directory, `${hash(scope)}.json`);
  const identity = (record) =>
    record
      ? {
          deliveryId: record.deliveryId,
          binding: record.binding,
          seatId: record.seatId,
          recipientBinding: record.recipientBinding,
          fingerprint: record.fingerprint,
        }
      : {};
  const uncertain = (record) => ({
    schemaVersion: 1,
    ...identity(record),
    outcome: "unconfirmed",
    deliveryStage: "uncertain",
    detail: "The original peer receipt is unresolved; no replacement was sent.",
  });
  const refused = (deliveryStage, detail) => ({
    schemaVersion: 1,
    outcome: "undelivered",
    deliveryStage,
    detail,
  });
  const valid = (record) =>
    record?.schemaVersion === 1 &&
    uuid(record.deliveryId) &&
    hex(record.binding) &&
    seat({ seatId: record.seatId, paneId: record.paneId, binding: record.recipientBinding }) &&
    typeof record.text === "string" &&
    record.text.length > 0 &&
    record.text.length <= 32_768 &&
    hex(record.fingerprint) &&
    fingerprint(record.seatId, record.recipientBinding, record.text) === record.fingerprint;
  const exact = (value, record) =>
    value?.schemaVersion === 1 &&
    Object.entries(identity(record)).every(([key, expected]) => value[key] === expected) &&
    ["stored", "delivered", "consumed", "uncertain", "rejected", "unavailable"].includes(
      value.deliveryStage,
    ) &&
    ["delivered", "unconfirmed", "undelivered", "offline"].includes(value.outcome);
  const terminal = (value, record) =>
    exact(value, record) &&
    ((["stored", "delivered", "consumed"].includes(value.deliveryStage) && value.outcome === "delivered") ||
      (["rejected", "unavailable"].includes(value.deliveryStage) &&
        ["undelivered", "offline"].includes(value.outcome)));
  const inspect = () => {
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (!valid(record)) throw new Error("Unreadable original peer receipt");
      return record;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const mutate = (fn) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A crash leaves this lock blocked; elapsed time is never proof of ownership.
    writeFileSync(`${path}.lock`, "exclusive\n", { flag: "wx", mode: 0o600 });
    try {
      return fn();
    } finally {
      unlinkSync(`${path}.lock`);
    }
  };
  const settle = (record) =>
    mutate(() => {
      // A delayed responder must not remove a newer original's claim.
      if (inspect()?.deliveryId === record.deliveryId) unlinkSync(path);
    });
  const reconcile = async (record, target, text) => {
    const query = new URLSearchParams({ binding: record.binding, fingerprint: record.fingerprint });
    const response = await request(`/${record.deliveryId}?${query}`);
    const value = response.ok ? await response.json() : undefined;
    if (!terminal(value, record)) return uncertain(record);
    settle(record);
    return (target === record.seatId || target === record.paneId) &&
      typeof text === "string" &&
      normalize(text) === normalize(record.text)
      ? value
      : refused(
          "unavailable",
          "The original peer message is settled. This different follow-up was not sent.",
        );
  };
  return async (target, text) => {
    let record;
    try {
      if (existsSync(`${path}.lock`)) return uncertain();
      record = inspect();
      if (record) return await reconcile(record, target, text);
      if (typeof target !== "string" || !target.trim() || typeof text !== "string" || !normalize(text))
        return refused("rejected", "Name a peer seat and provide its message.");
      if (target.length > 200 || text.length > 32_768)
        return refused("rejected", "Peer seat or message exceeds its bound; nothing was sent.");
      const response = await discover();
      const catalog = response.ok ? readPeerCatalog(await response.json()) : undefined;
      if (!catalog)
        return refused(
          [400, 401, 403, 413].includes(response.status) ? "rejected" : "unavailable",
          "No authenticated peer catalog is available; nothing was sent.",
        );
      const matches = catalog.seats.filter((entry) => entry.seatId === target || entry.paneId === target);
      if (matches.length !== 1)
        return refused("rejected", "The peer seat is unknown or ambiguous in this fleet; nothing was sent.");
      const recipient = matches[0];
      record = {
        schemaVersion: 1,
        deliveryId: randomUUID(),
        binding: catalog.sender.binding,
        seatId: recipient.seatId,
        paneId: recipient.paneId,
        recipientBinding: recipient.binding,
        fingerprint: fingerprint(recipient.seatId, recipient.binding, text),
        text: normalize(text),
      };
      try {
        mutate(() => writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }));
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const original = inspect();
        return original ? await reconcile(original, target, text) : uncertain();
      }
      const sent = await request("", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          seatId: record.seatId,
          recipientBinding: record.recipientBinding,
          text: record.text,
          delivery: { id: record.deliveryId, binding: record.binding },
        }),
      });
      const value = await sent.json().catch(() => undefined);
      const exactRefusal = exact(value, record) && ["rejected", "unavailable"].includes(value.deliveryStage);
      if (!terminal(value, record) || (!sent.ok && !exactRefusal)) return uncertain(record);
      settle(record);
      return value;
    } catch {
      return uncertain(record);
    }
  };
}
