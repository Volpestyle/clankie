// #623: post_note waited for the whole wake chain, up to the webhook's 15 seconds and then
// Clankie's lane, close to the relay's deadline. A post that timed out and was sent again is
// a new note that wakes its leads a second time. The post now answers once the addressees
// are journaled, each pending; the wakes settle after and show on later reads.
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { LeadWakeResult } from "@clankie/protocol/connector";
import { NoteWakes } from "../src/captain/note-wakes.ts";

const note = { sequence: 7, at: "2026-11-03T19:30:00.000Z", author: "Grok Bot", text: "deploy key rotated" };

it("answers once the addressees are journaled, before a slow webhook settles, and never wakes twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "note-wakes-"));
  try {
    const path = join(root, "note-wakes.json");
    let release: (result: LeadWakeResult) => void = () => {};
    const webhooks: string[] = [];
    const lanes: string[] = [];
    const wakes = new NoteWakes({
      path,
      webhookLeads: async () => ["grok"],
      webhook: (lead) => {
        webhooks.push(lead);
        return new Promise((resolve) => (release = resolve));
      },
      leadLane: async (text) => {
        lanes.push(text);
        return { via: "clankie", outcome: "delivered" };
      },
    });

    const answered = wakes.wake(note, ["grok", "clankie"]);
    expect(answered).toMatchObject({ sequence: 7, to: ["grok", "clankie"] });
    expect(answered.wakes).toBeUndefined();
    // Both are on disk as pending before any wake has settled. Read before anything awaits:
    // Clankie's lane here answers at once and settles on the next turn.
    const journal = JSON.parse(readFileSync(path, "utf8"));
    expect(journal.notes[0].pending.map((item: { lead: string }) => item.lead)).toEqual(["grok", "clankie"]);

    // Posting the same note again wakes nobody a second time.
    wakes.wake(note, ["grok", "clankie"]);
    release({ outcome: "sent", lead: "grok", message: "ok" } as LeadWakeResult);
    await wakes.settled(7);
    expect(webhooks).toEqual(["grok"]);
    expect(lanes).toHaveLength(1);
    expect(wakes.decorate(note).wakes?.map((wake) => [wake.lead, wake.reached])).toEqual(
      expect.arrayContaining([
        ["grok", "webhook"],
        ["clankie", "clankie"],
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a restart while a wake is pending settles it as uncertain and never sends it again", async () => {
  const root = await mkdtemp(join(tmpdir(), "note-wakes-"));
  try {
    const path = join(root, "note-wakes.json");
    const first = new NoteWakes({
      path,
      webhookLeads: async () => ["grok"],
      // The service stops while grok's webhook is still out.
      webhook: () => new Promise(() => {}),
      leadLane: async () => ({ via: "clankie", outcome: "delivered" }),
    });
    first.wake(note, ["grok"]);

    const sent: string[] = [];
    const restarted = new NoteWakes({
      path,
      webhookLeads: async () => ["grok"],
      webhook: async (lead) => {
        sent.push(lead);
        return { outcome: "sent", lead, message: "ok" } as LeadWakeResult;
      },
      leadLane: async () => ({ via: "clankie", outcome: "delivered" }),
    });
    expect(restarted.decorate(note).wakes).toEqual([
      expect.objectContaining({
        lead: "grok",
        reached: "none",
        steps: [{ via: "webhook", outcome: "uncertain" }],
      }),
    ]);
    restarted.wake(note, ["grok"]);
    await restarted.settled(7);
    expect(sent).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
