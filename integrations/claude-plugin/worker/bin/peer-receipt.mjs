// A fleet peer send owns one durable unresolved claim per sender pane and
// recipient seat; a claim never holds the sender's other recipients (VUH-2100).
// The claim is never a replay queue: later calls can only inspect its exact receipt.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admissionRefusal, checkFleetMembership } from "./admission.mjs";

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
  const prefix = hash(scope);
  // Claims from before VUH-2100 used one file per pane; it still holds its recipient.
  const legacy = join(directory, `${prefix}.json`);
  const lock = `${legacy}.lock`;
  const pathFor = (seatId) => join(directory, `${prefix}.${hash(seatId)}.json`);
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
    [
      "stored",
      "delivered",
      "consumed",
      "uncertain",
      "rejected",
      "unavailable",
      "recipient_gone",
      "superseded",
    ].includes(value.deliveryStage) &&
    ["delivered", "unconfirmed", "undelivered", "offline"].includes(value.outcome);
  const terminal = (value, record) =>
    exact(value, record) &&
    ((["stored", "delivered", "consumed"].includes(value.deliveryStage) && value.outcome === "delivered") ||
      (["rejected", "unavailable"].includes(value.deliveryStage) &&
        ["undelivered", "offline"].includes(value.outcome)) ||
      // A lost recipient, or an original nothing proved in time, ends
      // reconciliation without claiming whether it was read. Clearing permits
      // fresh intent, never replay of this ID.
      (["recipient_gone", "superseded"].includes(value.deliveryStage) && value.outcome === "unconfirmed"));
  const inspect = (path) => {
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      if (!valid(record)) throw new Error("Unreadable original peer receipt");
      return record;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  };
  /** Every unresolved claim of this pane, legacy first. */
  const claims = () => {
    let names;
    try {
      names = readdirSync(directory);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    return names
      .filter(
        (name) =>
          name === `${prefix}.json` ||
          (name.startsWith(`${prefix}.`) && /^[^.]+\.[a-f0-9]{64}\.json$/u.test(name)),
      )
      .sort((left, right) => left.length - right.length)
      .map((name) => join(directory, name))
      .map((path) => ({ path, record: inspect(path) }))
      .filter(({ record }) => record);
  };
  const mutate = (fn) => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // A crash leaves this lock blocked; elapsed time is never proof of ownership.
    writeFileSync(lock, "exclusive\n", { flag: "wx", mode: 0o600 });
    try {
      return fn();
    } finally {
      unlinkSync(lock);
    }
  };
  const settle = ({ path, record }) =>
    mutate(() => {
      // A delayed responder must not remove a newer original's claim.
      if (inspect(path)?.deliveryId === record.deliveryId) unlinkSync(path);
    });
  /**
   * A settled original frees its recipient: this call's different message goes
   * out as new intent, carrying the original's outcome back with it (VUH-2779).
   */
  const followUp = Symbol("follow-up");
  const previous = (value) => ({
    deliveryId: value.deliveryId,
    deliveryStage: value.deliveryStage,
    outcome: value.outcome,
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
  });
  const reconcile = async (claim, target, text) => {
    const { record } = claim;
    const query = new URLSearchParams({ binding: record.binding, fingerprint: record.fingerprint });
    const response = await request(`/${record.deliveryId}?${query}`);
    try {
      await checkFleetMembership(response);
    } catch (error) {
      return {
        ...uncertain(record),
        detail: `${error.message} The original peer receipt remains unresolved; reconcile it after admission is restored, do not resend.`,
      };
    }
    if (await admissionRefusal(response))
      return {
        ...uncertain(record),
        detail:
          "Fleet admission could not be verified just now. Wait briefly and reconcile this original peer receipt again; do not resend the message.",
      };
    const value = response.ok ? await response.json() : undefined;
    if (!terminal(value, record)) return uncertain(record);
    settle(claim);
    const same =
      (target === record.seatId || target === record.paneId) &&
      typeof text === "string" &&
      normalize(text) === normalize(record.text);
    if (same) return value;
    // The original is never resent; a different message is new intent.
    return { [followUp]: previous(value) };
  };
  const send = async (target, text) => {
    let record;
    try {
      if (existsSync(lock)) return uncertain();
      const held = claims().find((claim) => claim.record.seatId === target || claim.record.paneId === target);
      if (held) {
        const reconciled = await reconcile(held, target, text);
        if (!(followUp in reconciled)) return reconciled;
        const settled = reconciled[followUp];
        const sent = await send(target, text);
        return { ...sent, previous: settled };
      }
      if (typeof target !== "string" || !target.trim() || typeof text !== "string" || !normalize(text))
        return refused("rejected", "Name a peer seat and provide its message.");
      if (target.length > 200 || text.length > 32_768)
        return refused("rejected", "Peer seat or message exceeds its bound; nothing was sent.");
      const response = await discover();
      const refusal = await admissionRefusal(response);
      if (refusal) return { ...refused("unavailable", refusal.detail), retryable: true };
      const catalog = response.ok ? readPeerCatalog(await response.json()) : undefined;
      if (!catalog)
        return refused(
          [400, 401, 403, 413].includes(response.status) ? "rejected" : "unavailable",
          [401, 403].includes(response.status)
            ? "The service refused this native seat. Ask Clankie to confirm fleet admission; repeated retries cannot grant access. Nothing was sent."
            : "No authenticated peer catalog is available; nothing was sent.",
        );
      const matches = catalog.seats.filter((entry) => entry.seatId === target || entry.paneId === target);
      if (matches.length !== 1)
        return refused("rejected", "The peer seat is unknown or ambiguous in this fleet; nothing was sent.");
      const recipient = matches[0];
      const path = pathFor(recipient.seatId);
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
        const original = inspect(path);
        const reconciled = original ? await reconcile({ path, record: original }, target, text) : uncertain();
        return followUp in reconciled ? uncertain() : reconciled;
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
      const claim = { path, record };
      try {
        await checkFleetMembership(sent);
      } catch (error) {
        settle(claim);
        return refused("rejected", `${error.message} Nothing was sent.`);
      }
      const sendRefusal = await admissionRefusal(sent);
      if (sendRefusal) {
        settle(claim);
        return { ...refused("unavailable", sendRefusal.detail), retryable: true };
      }
      const value = await sent.json().catch(() => undefined);
      const exactRefusal = exact(value, record) && ["rejected", "unavailable"].includes(value.deliveryStage);
      if (!terminal(value, record) || (!sent.ok && !exactRefusal)) return uncertain(record);
      settle(claim);
      return value;
    } catch {
      return uncertain(record);
    }
  };
  return Object.assign(send, {
    /** Reconciles every claim; returns the first still unresolved, else the last result. */
    async reconcilePending() {
      let record;
      try {
        if (existsSync(lock)) return uncertain();
        let result;
        for (const claim of claims()) {
          record = claim.record;
          result = await reconcile(claim, record.seatId, record.text);
          if (result?.deliveryStage === "uncertain") return result;
        }
        return result;
      } catch {
        return uncertain(record);
      }
    },
  });
}
