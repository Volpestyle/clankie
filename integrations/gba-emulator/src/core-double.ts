import { createHash } from "node:crypto";
import type { GbaButton } from "@clankie/interactive-environment";
import type { FrozenGbaScenario } from "./contracts.ts";

/**
 * Deterministic GBA core TEST DOUBLE.
 *
 * This class is test infrastructure, NOT a product simulator: it is a
 * controllable, fully deterministic stand-in for a pinned real emulator core
 * (mGBA) sitting behind the same adapter boundary the real core will use.
 * It models exactly what the adapter consumes — button input consuming
 * frames, and a typed RAM-derived game-state view — so the adapter, driver,
 * and governed runtime integration can be proven byte-for-byte replayable in
 * CI without a ROM. ADR 0039 records how a libmgba-backed core replaces this
 * double in the next slice; the adapter-facing surface below is that seam.
 *
 * Determinism anchors: the frozen scenario fixture, the pinned savestate
 * identity digest, and the RNG seed. No wall clock, no Math.random, no I/O.
 */

export interface GbaCoreBattleState {
  battleId: string;
  turn: number;
  opponentHp: number;
  moveCursor: number;
  inputMode?: "action" | "move" | "resolving";
  actionCursor?: number;
  opponent?: {
    speciesId: string;
    level: number;
    maxHp: number;
  };
}

export interface GbaCoreMenuState {
  menuId: string;
  cursor: number;
  entries: { id: string; label: string }[];
}

export interface GbaCoreInventoryEntry {
  pocket: "items" | "key-items" | "poke-balls" | "tm-hm" | "berries";
  itemId: string;
  count: number;
}

export interface GbaCoreState {
  mode: "overworld" | "dialog" | "battle" | "battle_won" | "battle_lost";
  /**
   * Whether an otherwise idle overworld is accepting player input. Real
   * cores set this false during menu/field callback transitions; test doubles
   * may omit it and are treated as ready.
   */
  inputReady?: boolean;
  position: { mapId: string; x: number; y: number };
  facing: "north" | "east" | "south" | "west";
  dialogLineIndex: number;
  dialogLines?: string[];
  menu?: GbaCoreMenuState | null;
  inventory?: GbaCoreInventoryEntry[];
  party: {
    slot: number;
    speciesId: string;
    level: number;
    currentHp: number;
    maxHp: number;
    status: "healthy" | "fainted";
    moves: { moveId: string; power: number }[];
  }[];
  activePartySlot: number;
  battle: GbaCoreBattleState | null;
  frame: number;
  inputCount: number;
}

const DIRECTIONS: Record<
  "up" | "down" | "left" | "right",
  { dx: number; dy: number; facing: GbaCoreState["facing"] }
> = {
  up: { dx: 0, dy: -1, facing: "north" },
  down: { dx: 0, dy: 1, facing: "south" },
  left: { dx: -1, dy: 0, facing: "west" },
  right: { dx: 1, dy: 0, facing: "east" },
};

export function savestateIdentitySha256(savestateId: string): string {
  return createHash("sha256").update(`clankie-gba-core-double:${savestateId}`).digest("hex");
}

export class DeterministicGbaCoreDouble {
  public readonly coreId: string;
  private readonly scenario: FrozenGbaScenario;
  private readonly blocked: Set<string>;
  private rng: number;
  private state: GbaCoreState;

  public constructor(scenario: FrozenGbaScenario) {
    if (savestateIdentitySha256(scenario.savestateId) !== scenario.savestateSha256) {
      throw new Error("Pinned savestate identity digest does not match the frozen scenario");
    }
    this.coreId = scenario.coreId;
    this.scenario = scenario;
    this.blocked = new Set(scenario.map.blocked.map((point) => `${String(point.x)},${String(point.y)}`));
    this.blocked.add(`${String(scenario.trainer.position.x)},${String(scenario.trainer.position.y)}`);
    this.rng = scenario.rngSeed >>> 0;
    this.state = {
      mode: "overworld",
      position: structuredClone(scenario.player.start),
      facing: "east",
      dialogLineIndex: 0,
      dialogLines: [],
      menu: null,
      inventory: [{ pocket: "items", itemId: "potion", count: 1 }],
      party: scenario.player.party.map((member) => ({
        ...structuredClone(member),
        currentHp: member.maxHp,
        status: "healthy" as const,
      })),
      activePartySlot: scenario.player.party[0]!.slot,
      battle: null,
      frame: 0,
      inputCount: 0,
    };
  }

  public pressButton(button: GbaButton, holdFrames: number): void {
    this.state.frame += holdFrames + 1; // hold plus release edge
    this.state.inputCount += 1;
    if (this.state.mode === "overworld" && this.state.menu) {
      this.pressFieldMenu(button);
      return;
    }
    switch (this.state.mode) {
      case "overworld":
        this.pressOverworld(button);
        return;
      case "dialog":
        if (button === "a") this.advanceDialog();
        return;
      case "battle":
        this.pressBattle(button);
        return;
      case "battle_won":
      case "battle_lost":
        return;
    }
  }

  public advanceFrames(frames: number): void {
    this.state.frame += frames;
  }

  public gameState(): GbaCoreState {
    return structuredClone(this.state);
  }

  public ramStateSha256(): string {
    return createHash("sha256")
      .update(`gba-ram:${canonicalJson(this.state)}`)
      .digest("hex");
  }

  public framebufferSha256(): string {
    return createHash("sha256")
      .update(`gba-framebuffer:${String(this.state.frame)}:${canonicalJson(this.state)}`)
      .digest("hex");
  }

  private pressOverworld(button: GbaButton): void {
    if (button === "start") {
      this.openStartMenu();
      return;
    }
    if (button === "a") {
      const trainer = this.scenario.trainer;
      const reach =
        Math.abs(this.state.position.x - trainer.position.x) +
        Math.abs(this.state.position.y - trainer.position.y);
      if (reach <= trainer.interactionDistance) {
        this.state.mode = "dialog";
        this.state.dialogLineIndex = 0;
        this.state.dialogLines = [...trainer.dialog];
      }
      return;
    }
    if (button !== "up" && button !== "down" && button !== "left" && button !== "right") return;
    const direction = DIRECTIONS[button];
    this.state.facing = direction.facing;
    const next = { x: this.state.position.x + direction.dx, y: this.state.position.y + direction.dy };
    if (
      next.x < 0 ||
      next.y < 0 ||
      next.x >= this.scenario.map.width ||
      next.y >= this.scenario.map.height ||
      this.blocked.has(`${String(next.x)},${String(next.y)}`)
    ) {
      return;
    }
    this.state.position = { ...this.state.position, ...next };
  }

  private advanceDialog(): void {
    this.state.dialogLineIndex += 1;
    if (this.state.dialogLineIndex >= this.scenario.trainer.dialog.length) {
      this.state.mode = "battle";
      this.state.dialogLines = [];
      this.state.battle = {
        battleId: `${this.scenario.scenarioId}:${this.scenario.trainer.trainerId}`,
        turn: 1,
        opponentHp: this.scenario.trainer.opponent.maxHp,
        moveCursor: 0,
        inputMode: "move",
        opponent: structuredClone(this.scenario.trainer.opponent),
      };
      this.updateMoveMenu();
    }
  }

  private pressBattle(button: GbaButton): void {
    const battle = this.state.battle;
    if (!battle) throw new Error("Core double battle state is corrupt");
    const moves = this.activeMember().moves;
    if (button === "left" || button === "right" || button === "up" || button === "down") {
      const target = button === "left" || button === "right" ? battle.moveCursor ^ 1 : battle.moveCursor ^ 2;
      if (target < moves.length) battle.moveCursor = target;
      this.updateMoveMenu();
      return;
    }
    if (button !== "a") return;
    const move = moves[battle.moveCursor]!;
    const damage = move.power + (this.nextRng() % 2);
    battle.opponentHp = Math.max(0, battle.opponentHp - damage);
    if (battle.opponentHp === 0) {
      this.state.mode = "battle_won";
      this.state.menu = null;
      return;
    }
    const active = this.activeMember();
    active.currentHp = Math.max(0, active.currentHp - this.scenario.trainer.opponent.retaliationDamage);
    if (active.currentHp === 0) active.status = "fainted";
    if (this.state.party.every((member) => member.status === "fainted")) {
      this.state.mode = "battle_lost";
      this.state.menu = null;
      return;
    }
    battle.turn += 1;
  }

  private activeMember(): GbaCoreState["party"][number] {
    const member = this.state.party.find((candidate) => candidate.slot === this.state.activePartySlot);
    if (!member) throw new Error("Core double active party slot is corrupt");
    return member;
  }

  private updateMoveMenu(): void {
    const battle = this.state.battle;
    if (!battle) return;
    this.state.menu = {
      menuId: "battle-move-menu",
      cursor: battle.moveCursor,
      entries: this.activeMember().moves.map((move) => ({ id: move.moveId, label: move.moveId })),
    };
  }

  private openStartMenu(): void {
    this.state.menu = {
      menuId: "start-menu",
      cursor: 0,
      entries: [
        { id: "start-menu-1", label: "Pokémon" },
        { id: "start-menu-2", label: "Bag" },
        { id: "start-menu-6", label: "Exit" },
      ],
    };
  }

  private pressFieldMenu(button: GbaButton): void {
    const menu = this.state.menu;
    if (!menu) return;
    if (button === "b") {
      if (menu.menuId === "start-menu") {
        this.state.menu = null;
      } else {
        this.openStartMenu();
      }
      return;
    }
    if (button === "up") {
      menu.cursor = Math.max(0, menu.cursor - 1);
      return;
    }
    if (button === "down") {
      menu.cursor = Math.min(menu.entries.length - 1, menu.cursor + 1);
      return;
    }
    if (button !== "a" || menu.menuId !== "start-menu") return;
    const selected = menu.entries[menu.cursor]?.id;
    if (selected === "start-menu-1") {
      this.state.menu = {
        menuId: "party-menu",
        cursor: 0,
        entries: [
          ...this.state.party.map((member) => ({
            id: `party-slot-${String(member.slot)}`,
            label: member.speciesId,
          })),
          { id: "cancel", label: "Cancel" },
        ],
      };
    } else if (selected === "start-menu-2") {
      this.state.menu = {
        menuId: "bag-items",
        cursor: 0,
        entries: [
          ...(this.state.inventory ?? []).map((entry) => ({
            id: entry.itemId,
            label: `${entry.itemId} ×${String(entry.count)}`,
          })),
          { id: "cancel", label: "Cancel" },
        ],
      };
    } else if (selected === "start-menu-6") {
      this.state.menu = null;
    }
  }

  private nextRng(): number {
    this.rng = (Math.imul(this.rng, 1_664_525) + 1_013_904_223) >>> 0;
    return this.rng;
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
