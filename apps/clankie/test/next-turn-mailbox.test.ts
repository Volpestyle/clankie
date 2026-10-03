import { fsyncSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextTurnMailbox, nextTurnReceiverProof } from "../src/captain/next-turn-mailbox.ts";
import { fleetDeliveryStage } from "@clankie/protocol";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "next-turn-"));
  roots.push(root);
  const path = join(root, "mail.json");
  let now = 1;
  const mailbox = new NextTurnMailbox(path, () => now);
  return {
    mailbox,
    path,
    reload: () => new NextTurnMailbox(path, () => now),
    expire: () => {
      now += 86_400_001;
    },
  };
}

describe("session-bound next-turn mailbox", () => {
  it("a confirmed native output pipe acknowledges bridge delivery only", () => {
    const { mailbox, reload } = fixture();
    mailbox.observe("pane", "session");
    mailbox.store("pane", "session", "hello");
    const taken = mailbox.take("pane", "session")!;
    mailbox.acknowledge("pane", "other", taken.messageIds);
    expect(mailbox.store("pane", "session", "hello").deliveryStage).toBe("uncertain");
    mailbox.acknowledge("pane", "session", taken.messageIds);
    expect(reload().store("pane", "session", "hello").deliveryStage).toBe("delivered");
    expect(reload().take("pane", "session")).toBeUndefined();
  });

  it("stores durably and hands off once without claiming native consumption", () => {
    const { mailbox, reload } = fixture();
    mailbox.observe("kh2/w3:p8", "session-1:terminal-1");
    const receipt = mailbox.store("kh2/w3:p8", "session-1:terminal-1", "The answer");
    expect(receipt.deliveryStage).toBe("stored");
    expect(fleetDeliveryStage(receipt)).toBe("stored");
    const restarted = reload();
    expect(restarted.take("kh2/w3:p8", "session-1:terminal-1")?.additionalContext).toContain("The answer");
    expect(reload().take("kh2/w3:p8", "session-1:terminal-1")).toBeUndefined();
    expect(reload().store("kh2/w3:p8", "session-1:terminal-1", "The answer")).toMatchObject({
      outcome: "unconfirmed",
      deliveryStage: "uncertain",
    });
  });
  it("does not store for a session with no observed plugin hook", () => {
    expect(fixture().mailbox.store("pane", "session", "hello").deliveryStage).toBe("unavailable");
  });
  it("deduplicates exact replies while held", () => {
    const { mailbox } = fixture();
    mailbox.observe("pane", "session");
    expect(mailbox.store("pane", "session", "hello")).toEqual(mailbox.store("pane", "session", "hello"));
    expect(mailbox.take("pane", "session")?.additionalContext.match(/hello/gu)).toHaveLength(1);
  });
  it("never hands an old occupant's mail to a replacement", () => {
    const { mailbox } = fixture();
    mailbox.observe("pane", "old");
    mailbox.store("pane", "old", "secret");
    expect(mailbox.take("pane", "new")).toBeUndefined();
    expect(mailbox.store("pane", "new", "hello").deliveryStage).toBe("unavailable");
    mailbox.observe("pane", "new");
    expect(mailbox.take("pane", "new")).toBeUndefined();
  });
  it("expires held mail even if the session later reports another hook", () => {
    const { mailbox, expire } = fixture();
    mailbox.observe("pane", "session");
    mailbox.store("pane", "session", "old");
    expire();
    mailbox.observe("pane", "session");
    expect(mailbox.take("pane", "session")).toBeUndefined();
  });
});

it("requires authoritative proof of the current fleet, pane and native session", () => {
  const proof = {
    fleet: "kh2",
    pane: "w3:p8",
    nativeOccupantId: "claude:session-1",
    binding: { socketPath: "socket" },
    shell: { pid: 1, startTime: "now" },
    processes: [{ pid: 2, startTime: "now" }],
  };
  const expected = { fleet: "kh2", pane: "w3:p8", nativeOccupantId: "claude:session-1" };
  expect(nextTurnReceiverProof(proof, expected)).toBeTruthy();
  expect(nextTurnReceiverProof(undefined, expected)).toBeUndefined();
  expect(nextTurnReceiverProof({ ...proof, nativeSessionPending: true }, expected)).toBeUndefined();
  for (const change of [{ fleet: "other" }, { pane: "w3:p9" }, { nativeOccupantId: "claude:other" }])
    expect(nextTurnReceiverProof({ ...proof, ...change }, expected)).toBeUndefined();
});
it("a new process for the same session cannot inherit old mail", () => {
  const { mailbox } = fixture();
  mailbox.observe("pane", "session", "process-1");
  mailbox.store("pane", "session", "old");
  mailbox.observe("pane", "session", "process-2");
  expect(mailbox.take("pane", "session")).toBeUndefined();
});
it("wrong pane and expired/unknown/duplicate acknowledgments cannot revive or replay mail", () => {
  const { mailbox, expire } = fixture();
  mailbox.observe("pane", "session");
  mailbox.store("pane", "session", "old");
  const taken = mailbox.take("pane", "session")!;
  mailbox.acknowledge("other", "session", taken.messageIds);
  mailbox.acknowledge("pane", "session", ["unknown"]);
  expect(mailbox.store("pane", "session", "old").deliveryStage).toBe("uncertain");
  mailbox.acknowledge("pane", "session", taken.messageIds);
  mailbox.acknowledge("pane", "session", taken.messageIds);
  expect(mailbox.take("pane", "session")).toBeUndefined();
  expire();
  mailbox.acknowledge("pane", "session", taken.messageIds);
  expect(mailbox.take("pane", "session")).toBeUndefined();
});

it("retains the original receipt before selecting a newly available live channel", () => {
  const { mailbox } = fixture();
  mailbox.observe("pane", "session");
  expect(mailbox.receipt("pane", "session", "hello")).toBeUndefined();
  mailbox.store("pane", "session", "hello");
  expect(mailbox.receipt("pane", "session", "hello")?.deliveryStage).toBe("stored");
  mailbox.take("pane", "session");
  expect(mailbox.receipt("pane", "session", "hello")?.deliveryStage).toBe("uncertain");
});

it.each(["file", "directory"])(
  "failed %s persistence emits no context and cannot retry the take",
  (boundary) => {
    const { mailbox, reload } = fixture();
    mailbox.observe("pane", "session");
    mailbox.store("pane", "session", "hello");
    const original = vi.mocked(fsyncSync).getMockImplementation()!;
    if (boundary === "directory") vi.mocked(fsyncSync).mockImplementationOnce(original);
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error("disk sync failed");
    });
    let output: unknown;
    expect(() => {
      output = mailbox.take("pane", "session");
    }).toThrow("disk sync failed");
    expect(output).toBeUndefined();
    expect(mailbox.take("pane", "session")).toBeUndefined();
    expect(mailbox.receipt("pane", "session", "hello")?.deliveryStage).toBe("uncertain");
    const restarted = reload();
    if (boundary === "directory") expect(restarted.take("pane", "session")).toBeUndefined();
    else {
      // No output crossed the boundary before the failed file sync. The original
      // pending message may be taken once after durable storage recovers.
      expect(restarted.take("pane", "session")?.additionalContext).toContain("hello");
      expect(restarted.take("pane", "session")).toBeUndefined();
    }
  },
);

it.each(["{", "[]", '{"pane":{"binding":"session"}}'])(
  "unreadable journal %s is preserved and fences delivery",
  (corrupt) => {
    const { mailbox, path, reload } = fixture();
    mailbox.observe("pane", "session");
    mailbox.store("pane", "session", "old");
    mailbox.take("pane", "session");
    writeFileSync(path, corrupt);
    const reopened = reload();
    reopened.observe("pane", "session");
    expect(reopened.receipt("pane", "session", "old")?.deliveryStage).toBe("uncertain");
    expect(reopened.store("pane", "session", "old").deliveryStage).toBe("uncertain");
    expect(reopened.take("pane", "session")).toBeUndefined();
    reopened.acknowledge("pane", "session", []);
    expect(readFileSync(path, "utf8")).toBe(corrupt);
  },
);
