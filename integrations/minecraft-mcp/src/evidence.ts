import type { MinecraftEffectCheck, MinecraftEffectEvidence } from "@clankie/protocol";
import minecraftData from "minecraft-data";

type MinecraftBlockPosition = { x: number; y: number; z: number };
const key = (position: MinecraftBlockPosition) => `${position.x},${position.y},${position.z}`;
const canonical = (name: string) => `minecraft:${name.replace(/^minecraft:/u, "")}`;

/** Special -2 set_slot uses PlayerInventory indexes, not window-zero slot indexes. */
export function playerWindowSlot(index: number): number | null {
  if (index >= 0 && index <= 8) return index + 36;
  if (index >= 9 && index <= 35) return index;
  if (index === 40) return 45;
  return null;
}

/** Inbound packets only. Never consume blockUpdate: Mineflayer emits optimistic air there. */
export class PacketEvidence {
  private blocks = new Map<string, { block: string; at: number }>();
  private slots = new Map<number, { item: string; count: number }>();
  private inventoryAt = 0;
  private itemAt = new Map<string, number>();
  private data: ReturnType<typeof minecraftData>;

  constructor(version: string) {
    this.data = minecraftData(version);
  }

  block(position: MinecraftBlockPosition, stateId: number, at = Date.now()): void {
    const name = this.data.blocksByStateId[stateId]?.name;
    if (!name) return;
    this.blocks.set(key(position), { block: canonical(name), at });
    while (this.blocks.size > 4096) this.blocks.delete(this.blocks.keys().next().value as string);
  }

  slot(index: number, value: unknown, at = Date.now()): void {
    const slot = value as {
      itemId?: number;
      blockId?: number;
      itemCount?: number;
      count?: number;
      present?: boolean;
    } | null;
    const itemId = slot?.itemId ?? slot?.blockId;
    const count = slot?.itemCount ?? slot?.count ?? 0;
    const name = itemId === undefined ? undefined : this.data.items[itemId]?.name;
    const previous = this.slots.get(index);
    if (index >= 9 && index <= 45) {
      if (previous) this.itemAt.set(previous.item, at);
      if (name && count > 0) this.itemAt.set(canonical(name), at);
    }
    if (slot?.present === false || !name || count <= 0) this.slots.delete(index);
    else this.slots.set(index, { item: canonical(name), count });
  }

  snapshot(items: unknown[], at = Date.now()): void {
    this.slots.clear();
    items.forEach((item, index) => this.slot(index, item, at));
    // A full player window observes absence as well as present items.
    this.inventoryAt = at;
  }

  inventory(item: string): { count: number; at: number } {
    let count = 0;
    for (const [index, slot] of this.slots) {
      // Player inventory excludes crafting/result/armor slots; includes hotbar and offhand.
      if (index >= 9 && index <= 45 && slot.item === canonical(item)) count += slot.count;
    }
    return { count, at: Math.max(this.inventoryAt, this.itemAt.get(canonical(item)) ?? 0) };
  }

  blockEffect(position: MinecraftBlockPosition, expected: string, since: number): MinecraftEffectEvidence {
    const observed = this.blocks.get(key(position));
    if (!observed || observed.at < since) return { outcome: "unknown", reason: "not_observed" };
    const check: MinecraftEffectCheck = {
      type: "block",
      position,
      expected: canonical(expected),
      observed: observed.block,
    };
    return {
      outcome: check.expected === check.observed ? "verified" : "refuted",
      source: "server_packet",
      observedAt: observed.at,
      checks: [check],
    };
  }

  inventoryEffect(item: string, expected: number, since: number): MinecraftEffectEvidence {
    const observed = this.inventory(item);
    if (observed.at < since) return { outcome: "unknown", reason: "not_observed" };
    return {
      outcome: observed.count === expected ? "verified" : "refuted",
      source: "server_packet",
      observedAt: observed.at,
      checks: [{ type: "inventory", item: canonical(item), expected, observed: observed.count }],
    };
  }
}
