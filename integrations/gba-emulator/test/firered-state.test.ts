import { describe, expect, it } from "vitest";
import {
  FIRERED_BATTLE_MOVES_ROM_OFFSET,
  FIRERED_BATTLE_MOVE_STRIDE,
  decodeFireRedState,
  decodeFireRedText,
} from "../src/firered-state.ts";

const EWRAM_BASE = 0x02000000;
const IWRAM_BASE = 0x03000000;
const ewramOffset = (address: number) => address - EWRAM_BASE;
const iwramOffset = (address: number) => address - IWRAM_BASE;
const SUBSTRUCT_ORDERS: readonly (readonly number[])[] = [
  [0, 1, 2, 3],
  [0, 1, 3, 2],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
  [0, 2, 3, 1],
  [0, 3, 2, 1],
  [1, 0, 2, 3],
  [1, 0, 3, 2],
  [2, 0, 1, 3],
  [3, 0, 1, 2],
  [2, 0, 3, 1],
  [3, 0, 2, 1],
  [1, 2, 0, 3],
  [1, 3, 0, 2],
  [2, 1, 0, 3],
  [3, 1, 0, 2],
  [2, 3, 0, 1],
  [3, 2, 0, 1],
  [1, 2, 3, 0],
  [1, 3, 2, 0],
  [2, 1, 3, 0],
  [3, 1, 2, 0],
  [2, 3, 1, 0],
  [3, 2, 1, 0],
];

interface SyntheticFireRedMemory {
  ewram: Uint8Array;
  iwram: Uint8Array;
  ewramView: DataView;
  iwramView: DataView;
}

const syntheticRom = (): Uint8Array => {
  const rom = new Uint8Array(FIRERED_BATTLE_MOVES_ROM_OFFSET + 355 * FIRERED_BATTLE_MOVE_STRIDE);
  for (const [move, power] of [
    [33, 35],
    [45, 0],
    [52, 40],
    [165, 50],
  ] as const) {
    rom[FIRERED_BATTLE_MOVES_ROM_OFFSET + move * FIRERED_BATTLE_MOVE_STRIDE + 1] = power;
  }
  return rom;
};

const syntheticMemory = (): SyntheticFireRedMemory => {
  const ewram = new Uint8Array(0x40000);
  const iwram = new Uint8Array(0x8000);
  ewram[0x36e48] = 13;
  ewram[0x36e4a] = 13;
  ewram[0x36e58] = 2;
  return {
    ewram,
    iwram,
    ewramView: new DataView(ewram.buffer),
    iwramView: new DataView(iwram.buffer),
  };
};

const writeEncryptedPartyMember = (
  memory: SyntheticFireRedMemory,
  options: {
    slot?: number;
    personality?: number;
    otId?: number;
    species?: number;
    moves?: number[];
    level?: number;
    currentHp?: number;
    maxHp?: number;
  } = {},
): void => {
  const slot = options.slot ?? 0;
  const personality = options.personality ?? 0;
  const otId = options.otId ?? 0x12345678;
  const base = ewramOffset(0x02024284) + slot * 0x64;
  const decrypted = new Uint8Array(48);
  const decryptedView = new DataView(decrypted.buffer);
  const order = SUBSTRUCT_ORDERS[personality % 24]!;
  decryptedView.setUint16(order[0]! * 12, options.species ?? 25, true);
  for (const [index, move] of (options.moves ?? [33, 45]).entries()) {
    decryptedView.setUint16(order[1]! * 12 + index * 2, move, true);
  }
  let checksum = 0;
  for (let offset = 0; offset < decrypted.byteLength; offset += 2) {
    checksum = (checksum + decryptedView.getUint16(offset, true)) & 0xffff;
  }
  memory.ewramView.setUint32(base, personality, true);
  memory.ewramView.setUint32(base + 4, otId, true);
  memory.ewramView.setUint16(base + 0x1c, checksum, true);
  const key = personality ^ otId;
  for (let offset = 0; offset < decrypted.byteLength; offset += 4) {
    memory.ewramView.setUint32(base + 0x20 + offset, decryptedView.getUint32(offset, true) ^ key, true);
  }
  memory.ewramView.setUint8(base + 0x54, options.level ?? 12);
  memory.ewramView.setUint16(base + 0x56, options.currentHp ?? 31, true);
  memory.ewramView.setUint16(base + 0x58, options.maxHp ?? 35, true);
};

const writeBattleMon = (
  memory: SyntheticFireRedMemory,
  battler: number,
  options: {
    species: number;
    level: number;
    currentHp: number;
    maxHp: number;
    moves: { id: number; pp: number }[];
  },
): void => {
  const base = ewramOffset(0x02023be4) + battler * 0x58;
  memory.ewramView.setUint16(base, options.species, true);
  memory.ewramView.setUint16(base + 0x28, options.currentHp, true);
  memory.ewramView.setUint8(base + 0x2a, options.level);
  memory.ewramView.setUint16(base + 0x2c, options.maxHp, true);
  for (const [slot, move] of options.moves.entries()) {
    memory.ewramView.setUint16(base + 0x0c + slot * 2, move.id, true);
    memory.ewramView.setUint8(base + 0x24 + slot, move.pp);
  }
};

const writeBattle = (memory: SyntheticFireRedMemory): void => {
  memory.iwramView.setUint8(iwramOffset(0x03003529), 0x02);
  memory.ewramView.setUint8(ewramOffset(0x02023bcc), 2);
  memory.ewramView.setUint16(ewramOffset(0x02023bce), 0, true);
  memory.ewramView.setUint8(ewramOffset(0x02023bd6), 0);
  memory.ewramView.setUint8(ewramOffset(0x02023bd6) + 1, 1);
  writeBattleMon(memory, 0, {
    species: 25,
    level: 12,
    currentHp: 27,
    maxHp: 35,
    moves: [
      { id: 33, pp: 20 },
      { id: 52, pp: 10 },
    ],
  });
  writeBattleMon(memory, 1, {
    species: 4,
    level: 7,
    currentHp: 18,
    maxHp: 21,
    moves: [{ id: 33, pp: 30 }],
  });
  memory.ewramView.setUint8(ewramOffset(0x02023ffc), 1);
  memory.ewramView.setUint32(ewramOffset(0x02022b4c), 8, true);
};

describe("version-pinned FireRed state decoder", () => {
  it("decodes shuffled, checksum-protected party records and ROM move power", () => {
    const memory = syntheticMemory();
    const rom = syntheticRom();
    memory.ewramView.setUint8(ewramOffset(0x02024029), 1);
    writeEncryptedPartyMember(memory, { personality: 8 });

    expect(decodeFireRedState(memory, rom)).toMatchObject({
      overworld: { x: 13, y: 13, facing: "north" },
      party: [
        {
          slot: 0,
          speciesId: "firered-species-25",
          level: 12,
          currentHp: 31,
          maxHp: 35,
          status: "healthy",
          moves: [
            { moveId: "firered-move-33", power: 35 },
            { moveId: "firered-move-45", power: 0 },
          ],
        },
      ],
      battle: null,
      dialogLines: [],
      menu: null,
    });

    const secureByte = ewramOffset(0x02024284) + 0x20;
    memory.ewram[secureByte] = memory.ewram[secureByte]! ^ 1;
    expect(() => decodeFireRedState(memory, rom)).toThrow(/checksum/);
  });

  it("distinguishes battle action, move, and resolving phases from controller commands", () => {
    const memory = syntheticMemory();
    const rom = syntheticRom();
    memory.ewramView.setUint8(ewramOffset(0x02024029), 1);
    writeEncryptedPartyMember(memory);
    writeBattle(memory);
    memory.ewramView.setUint32(ewramOffset(0x02023bc8), 1, true);
    memory.ewramView.setUint8(ewramOffset(0x02022bc4), 18);
    memory.ewramView.setUint8(ewramOffset(0x02023ff8), 2);

    expect(decodeFireRedState(memory, rom)).toMatchObject({
      party: [{ currentHp: 27, moves: [{ power: 35 }, { power: 40 }] }],
      battle: {
        battleTypeFlags: 8,
        outcome: 0,
        activePartySlot: 0,
        actionCursor: 2,
        moveCursor: 1,
        inputMode: "action",
        opponent: {
          speciesId: "firered-species-4",
          level: 7,
          currentHp: 18,
          maxHp: 21,
        },
      },
      menu: { menuId: "battle-action-menu", cursor: 2 },
    });

    memory.ewramView.setUint8(ewramOffset(0x02022bc4), 20);
    expect(decodeFireRedState(memory, rom)).toMatchObject({
      battle: { inputMode: "move", legalMoves: [{ power: 35 }, { power: 40 }] },
      menu: {
        menuId: "battle-move-menu",
        cursor: 1,
        entries: [{ id: "firered-move-33" }, { id: "firered-move-52" }],
      },
    });

    memory.ewramView.setUint32(ewramOffset(0x02023bc8), 0, true);
    expect(decodeFireRedState(memory, rom)).toMatchObject({
      battle: { inputMode: "resolving" },
      menu: null,
    });
  });

  it("treats the all-zero in-battle initialization window as a transition", () => {
    const memory = syntheticMemory();
    const rom = syntheticRom();
    memory.iwramView.setUint8(iwramOffset(0x03003529), 0x02);
    memory.ewramView.setUint8(ewramOffset(0x02023bcc), 2);
    memory.ewram.set([0, 1], ewramOffset(0x02023bd6));
    expect(decodeFireRedState(memory, rom).battle).toBeNull();

    memory.ewramView.setUint16(ewramOffset(0x02023be4), 4, true);
    expect(() => decodeFireRedState(memory, rom)).toThrow(/active party slot|battler 0/);
  });

  it("decodes field dialog and start, party, and bag menus without framebuffer guessing", () => {
    const memory = syntheticMemory();
    const rom = syntheticRom();
    memory.ewramView.setUint8(ewramOffset(0x02024029), 1);
    writeEncryptedPartyMember(memory);
    memory.ewramView.setUint8(ewramOffset(0x0203709c), 1);
    memory.ewram.set([0xc2, 0xbf, 0xc6, 0xc6, 0xc9, 0xab, 0xff], ewramOffset(0x02021d18));
    expect(decodeFireRedState(memory, rom).dialogLines).toEqual(["HELLO!"]);

    memory.ewramView.setUint8(ewramOffset(0x0203709c), 0);
    memory.ewramView.setUint32(ewramOffset(0x020370f0), 0x08012345, true);
    memory.ewramView.setUint8(ewramOffset(0x020370f5), 3);
    memory.ewramView.setUint8(ewramOffset(0x020370f4), 1);
    memory.ewram.set([0, 1, 6], ewramOffset(0x020370f6));
    const startMenuTask = iwramOffset(0x03005090);
    memory.iwramView.setUint32(startMenuTask, 0x0806f1f1, true);
    memory.iwramView.setUint8(startMenuTask + 4, 1);
    expect(decodeFireRedState(memory, rom).menu).toEqual({
      menuId: "start-menu",
      cursor: 1,
      entries: [
        { id: "start-menu-0", label: "Pokédex" },
        { id: "start-menu-1", label: "Pokémon" },
        { id: "start-menu-6", label: "Exit" },
      ],
    });

    memory.iwramView.setUint32(iwramOffset(0x030030f4), 0x0811eba1, true);
    memory.ewramView.setInt8(ewramOffset(0x0203b0a0) + 9, 0);
    expect(decodeFireRedState(memory, rom).menu).toMatchObject({
      menuId: "party-menu",
      cursor: 0,
      entries: [{ id: "party-slot-0" }, { id: "cancel" }],
    });

    memory.iwramView.setUint32(iwramOffset(0x030030f4), 0, true);
    memory.ewramView.setUint8(ewramOffset(0x0203acfc) + 5, 1);
    memory.ewramView.setUint16(ewramOffset(0x0203acfc) + 6, 2, true);
    expect(decodeFireRedState(memory, rom).menu).toMatchObject({
      menuId: "bag-poke-balls",
      cursor: 0,
      entries: [{ id: "cancel" }],
    });

    // HELP intercepts input without replacing the bag's callback or open flag.
    memory.ewramView.setUint8(ewramOffset(0x0203f177), 1);
    expect(decodeFireRedState(memory, rom).menu).toEqual({
      menuId: "help-system",
      cursor: 0,
      entries: [],
    });
  });

  it("decodes the naming screen instead of leaving the overworld to lie", () => {
    const memory = syntheticMemory();
    const rom = syntheticRom();

    // Loading callback: the heap block is not initialized yet, so only
    // presence is reported.
    memory.iwramView.setUint32(iwramOffset(0x030030f4), 0x0809d9e1, true);
    expect(decodeFireRedState(memory, rom).menu).toEqual({
      menuId: "naming-screen",
      cursor: 0,
      entries: [{ id: "loading", label: "the naming screen is still loading" }],
    });

    // Running callback without a data block is corruption, not a menu.
    memory.iwramView.setUint32(iwramOffset(0x030030f4), 0x0809fb71, true);
    expect(() => decodeFireRedState(memory, rom)).toThrow(/naming screen/);

    // Running: typed text, keyboard page, and subject decode from the block.
    const dataAddress = 0x02030000;
    memory.ewramView.setUint32(ewramOffset(0x0203998c), dataAddress, true);
    memory.ewram.fill(0xff, ewramOffset(dataAddress) + 0x1800, ewramOffset(dataAddress) + 0x1810);
    memory.ewram.set([0xc1, 0xbb], ewramOffset(dataAddress) + 0x1800); // "GA"
    memory.ewramView.setUint8(ewramOffset(dataAddress) + 0x1e22, 1); // upper-case page
    memory.ewramView.setUint8(ewramOffset(dataAddress) + 0x1e2c, 2); // caught-mon template
    expect(decodeFireRedState(memory, rom).menu).toEqual({
      menuId: "naming-screen",
      cursor: 0,
      entries: [
        { id: "typed-text", label: 'typed so far: "GA"' },
        { id: "keyboard-page", label: "upper-case keyboard" },
        { id: "naming", label: "naming a caught Pokémon" },
      ],
    });
    // The keyboard owns input here; the field must not claim readiness.
    expect(decodeFireRedState(memory, rom).fieldInputReady).toBe(false);

    // The machine state carries the exact text and the keyboard cursor (from
    // the cursor sprite's data words), which is what enter_text navigates by.
    expect(decodeFireRedState(memory, rom).naming).toEqual({
      text: "GA",
      page: "upper-case",
      row: 0,
      column: 0,
    });
    memory.ewramView.setUint8(ewramOffset(0x0202066a), 5); // column
    memory.ewramView.setUint8(ewramOffset(0x0202066c), 2); // row
    expect(decodeFireRedState(memory, rom).naming).toMatchObject({ row: 2, column: 5 });

    // A cursor outside the keyboard refuses rather than navigates blind.
    memory.ewramView.setUint8(ewramOffset(0x0202066a), 9);
    expect(() => decodeFireRedState(memory, rom)).toThrow(/cursor/);
    memory.ewramView.setUint8(ewramOffset(0x0202066a), 0);

    // An empty buffer reads as such rather than as invented text.
    memory.ewram.fill(0xff, ewramOffset(dataAddress) + 0x1800, ewramOffset(dataAddress) + 0x1810);
    expect(decodeFireRedState(memory, rom).menu?.entries[0]).toEqual({
      id: "typed-text",
      label: "nothing typed yet",
    });

    // A page outside the cycled domain refuses rather than guesses.
    memory.ewramView.setUint8(ewramOffset(dataAddress) + 0x1e22, 3);
    expect(() => decodeFireRedState(memory, rom)).toThrow(/naming screen/);
  });

  it("reports field input ready only when the overworld callback is unlocked", () => {
    const memory = syntheticMemory();
    const rom = syntheticRom();
    memory.iwramView.setUint32(iwramOffset(0x030030f4), 0x080565b5, true);
    expect(decodeFireRedState(memory, rom).fieldInputReady).toBe(true);
    memory.ewramView.setUint8(ewramOffset(0x0203f177), 1);
    expect(decodeFireRedState(memory, rom).fieldInputReady).toBe(false);
    memory.ewramView.setUint8(ewramOffset(0x0203f177), 0);
    memory.iwramView.setUint8(iwramOffset(0x03000f9c), 1);
    expect(decodeFireRedState(memory, rom).fieldInputReady).toBe(false);
  });

  it("decodes encrypted quantities from all save-block bag pockets", () => {
    const memory = syntheticMemory();
    const rom = syntheticRom();
    const saveBlock1 = 0x02010000;
    const saveBlock2 = 0x02018000;
    const quantityKey = 0x4567;
    memory.iwramView.setUint32(iwramOffset(0x03005008), saveBlock1, true);
    memory.iwramView.setUint32(iwramOffset(0x0300500c), saveBlock2, true);
    memory.ewramView.setUint32(ewramOffset(saveBlock2) + 0x0f20, 0x12340000 | quantityKey, true);
    memory.ewramView.setUint16(ewramOffset(saveBlock1) + 0x0310, 13, true);
    memory.ewramView.setUint16(ewramOffset(saveBlock1) + 0x0312, quantityKey ^ 7, true);
    memory.ewramView.setUint16(ewramOffset(saveBlock1) + 0x0430, 4, true);
    memory.ewramView.setUint16(ewramOffset(saveBlock1) + 0x0432, quantityKey ^ 12, true);

    expect(decodeFireRedState(memory, rom).inventory).toEqual([
      { pocket: "items", itemId: "firered-item-13", count: 7 },
      { pocket: "poke-balls", itemId: "firered-item-4", count: 12 },
    ]);
  });

  it("decodes the accented range, because the game spells POKéMON with it", () => {
    // P O K é M O N — 0x1b carried the most common word in the script, and an
    // uncovered charmap rendered it "POK�MON" in every transcript he read.
    expect(decodeFireRedText(Uint8Array.from([0xca, 0xc9, 0xc5, 0x1b, 0xc7, 0xc9, 0xc8, 0xff]))).toEqual([
      "POKéMON",
    ]);
    // É Ä ñ ç — a sample across the upper and lower accented blocks.
    expect(decodeFireRedText(Uint8Array.from([0x06, 0xf1, 0x29, 0x19, 0xff]))).toEqual(["ÉÄñç"]);
  });

  it("decodes control-bearing text and rejects malformed snapshots and domains", () => {
    expect(decodeFireRedText(Uint8Array.from([0xbb, 0xfc, 0x01, 0x04, 0xbc, 0xfe, 0xbd, 0xff]))).toEqual([
      "AB",
      "C",
    ]);
    const memory = syntheticMemory();
    const rom = syntheticRom();
    expect(() => decodeFireRedState({ ewram: memory.ewram, iwram: new Uint8Array(12) }, rom)).toThrow(
      /IWRAM/,
    );
    memory.ewramView.setUint8(ewramOffset(0x02024029), 7);
    expect(() => decodeFireRedState(memory, rom)).toThrow(/party count/);

    const oldIncorrectInBattleOffset = iwramOffset(0x0300351d);
    memory.ewramView.setUint8(ewramOffset(0x02024029), 0);
    memory.iwramView.setUint8(oldIncorrectInBattleOffset, 0x02);
    expect(decodeFireRedState(memory, rom).battle).toBeNull();
  });
});
