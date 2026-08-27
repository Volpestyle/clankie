import type {
  GbaCoreInventoryEntry,
  GbaCoreMenuState,
  GbaCoreNamingState,
  GbaCoreState,
  GbaCoreSurroundings,
} from "./core-double.ts";
import {
  GBA_EWRAM_BASE,
  GBA_EWRAM_SIZE,
  decodeFireRedMapExits,
  decodeFireRedMapGrid,
  decodeFireRedObjectEvents,
  decodeFireRedOverworld,
  fireRedSurroundings,
  type FireRedObjectEvent,
  type FireRedOverworldFields,
} from "./firered-ram-map.ts";
import { GBA_IWRAM_BUS_ADDRESS, GBA_IWRAM_BYTE_LENGTH } from "./mgba-core.ts";

/**
 * Version-pinned RAM/ROM profile for Pokémon FireRed (U) v1.0.
 *
 * The ROM identity is frozen in
 * `fixtures/firered-bedroom-route/v1/scenario.json`. Addresses and layouts
 * match pret/pokefirered commit df4449a27cd78dd747ce269e47d3ab4a0149d8f4
 * and are corroborated by the matching link symbols at
 * Kakumi/Pokebot commit 752042afa11330ba7af8203feeb2af966e25aa99.
 * Every decoder validates lengths, checksums, bounds, and enum domains before
 * returning state.
 */
export const FIRERED_US_V10_ROM_SHA256 = "3d0c79f1627022e18765766f6cb5ea067f6b5bf7dca115552189ad65a5c3a8ac";

const G_MAIN_ADDRESS = 0x030030f0;
const G_MAIN_IN_BATTLE_ADDRESS = G_MAIN_ADDRESS + 0x439;
const G_DISPLAYED_STRING_BATTLE_ADDRESS = 0x0202298c;
const S_TEXT_PRINTERS_ADDRESS = 0x02020034;
const G_BATTLE_TYPE_FLAGS_ADDRESS = 0x02022b4c;
const G_BATTLE_BUFFER_A_ADDRESS = 0x02022bc4;
const G_BATTLE_CONTROLLER_EXEC_FLAGS_ADDRESS = 0x02023bc8;
const G_BATTLERS_COUNT_ADDRESS = 0x02023bcc;
const G_BATTLER_PARTY_INDEXES_ADDRESS = 0x02023bce;
const G_BATTLER_POSITIONS_ADDRESS = 0x02023bd6;
const G_BATTLE_MONS_ADDRESS = 0x02023be4;
const G_BATTLE_OUTCOME_ADDRESS = 0x02023e8a;
const G_ACTION_SELECTION_CURSOR_ADDRESS = 0x02023ff8;
const G_MOVE_SELECTION_CURSOR_ADDRESS = 0x02023ffc;
const G_PLAYER_PARTY_COUNT_ADDRESS = 0x02024029;
const G_PLAYER_PARTY_ADDRESS = 0x02024284;
const G_STRING_VAR_4_ADDRESS = 0x02021d18;
const S_MESSAGE_BOX_TYPE_ADDRESS = 0x0203709c;
const S_START_MENU_CALLBACK_ADDRESS = 0x020370f0;
const S_START_MENU_CURSOR_ADDRESS = 0x020370f4;
const S_START_MENU_COUNT_ADDRESS = 0x020370f5;
const S_START_MENU_ORDER_ADDRESS = 0x020370f6;
const G_BAG_MENU_STATE_ADDRESS = 0x0203acfc;
const S_IN_HELP_SYSTEM_ADDRESS = 0x0203f177;
const G_PARTY_MENU_ADDRESS = 0x0203b0a0;
const G_SAVE_BLOCK1_POINTER_ADDRESS = 0x03005008;
const G_SAVE_BLOCK2_POINTER_ADDRESS = 0x0300500c;
const G_TASKS_ADDRESS = 0x03005090;
const S_GLOBAL_SCRIPT_CONTEXT_ADDRESS = 0x03000eb0;
const S_LOCK_FIELD_CONTROLS_ADDRESS = 0x03000f9c;

const TASK_START_MENU_HANDLE_INPUT = 0x0806f1f0;
const CB2_OVERWORLD = 0x080565b4;
const CB2_UPDATE_PARTY_MENU = 0x0811eba0;
const NATIVE_WAIT_FOR_A_OR_B_PRESS = 0x0806b898;

// Naming screen (`naming_screen.c`). `sNamingScreen` points at the
// heap-allocated NamingScreenData; the typed text, keyboard page, and template
// live at fixed offsets inside it.
const S_NAMING_SCREEN_POINTER_ADDRESS = 0x0203998c;
const CB2_LOAD_NAMING_SCREEN = 0x0809d9e0;
const CB2_NAMING_SCREEN = 0x0809fb70;
const NAMING_SCREEN_TEXT_BUFFER_OFFSET = 0x1800;
const NAMING_SCREEN_TEXT_BUFFER_BYTE_LENGTH = 0x10;
const NAMING_SCREEN_CURRENT_PAGE_OFFSET = 0x1e22;
const NAMING_SCREEN_TEMPLATE_NUM_OFFSET = 0x1e2c;
// The keyboard cursor is gSprites slot 0; its data words carry the logical
// (column, row), which keep tracking even on the button strip where the OAM
// pixel shadow stops. Verified empirically (2026-07-26 naming probe): +1 per
// move, 9-column ring on the letter pages, 7 on symbols.
const G_SPRITES_CURSOR_COLUMN_ADDRESS = 0x0202066a;
const G_SPRITES_CURSOR_ROW_ADDRESS = 0x0202066c;
const NAMING_SCREEN_MAX_COLUMN = 8;
const NAMING_SCREEN_MAX_ROW = 3;
/** `currentPage` domain, in the order the pages cycle (`KBPAGE_*`). */
const NAMING_SCREEN_PAGES = ["symbols", "upper-case", "lower-case"] as const;
/** `templateNum` domain (`NAMING_SCREEN_*` template ids). */
const NAMING_SCREEN_SUBJECTS = [
  "the player",
  "a storage box",
  "a caught Pokémon",
  "a Pokémon's nickname",
  "the rival",
] as const;

/** `gBattleMoves` starts here in the supported ROM and has a 12-byte stride. */
export const FIRERED_BATTLE_MOVES_ROM_OFFSET = 0x00250c04;
export const FIRERED_BATTLE_MOVE_STRIDE = 12;

const PARTY_CAPACITY = 6;
const POKEMON_BYTE_LENGTH = 0x64;
const BOX_SECURE_OFFSET = 0x20;
const BOX_SECURE_BYTE_LENGTH = 48;
const BATTLE_MON_BYTE_LENGTH = 0x58;
const BATTLE_BUFFER_BYTE_LENGTH = 0x200;
const MAX_SPECIES_ID = 439;
const MAX_MOVE_ID = 354;
const CONTROLLER_CHOOSE_ACTION = 18;
const CONTROLLER_CHOOSE_MOVE = 20;
const STRUGGLE_MOVE_ID = 165;
const TASK_BYTE_LENGTH = 40;
const TASK_CAPACITY = 16;
const SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET = 0x0f20;
const SAVE_BLOCK1_MINIMUM_LENGTH = 0x05f8;
const MAX_ITEM_ID = 375;

const BAG_POCKETS = [
  { pocket: "items", offset: 0x0310, capacity: 42 },
  { pocket: "key-items", offset: 0x03b8, capacity: 30 },
  { pocket: "poke-balls", offset: 0x0430, capacity: 13 },
  { pocket: "tm-hm", offset: 0x0464, capacity: 58 },
  { pocket: "berries", offset: 0x054c, capacity: 43 },
] as const;

/**
 * Physical substruct index for logical substruct types 0..3, selected by
 * personality modulo 24. This is the exact `GetSubstruct` permutation table.
 */
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

const START_MENU_LABELS = [
  "Pokédex",
  "Pokémon",
  "Bag",
  "Player",
  "Save",
  "Option",
  "Exit",
  "Retire",
  "Player",
] as const;

const ACTION_MENU_ENTRIES = [
  { id: "fight", label: "Fight" },
  { id: "bag", label: "Bag" },
  { id: "pokemon", label: "Pokémon" },
  { id: "run", label: "Run" },
] as const;

export interface FireRedMemorySnapshot {
  ewram: Uint8Array;
  iwram: Uint8Array;
}

interface FireRedDecodedBattle {
  battleTypeFlags: number;
  outcome: number;
  activePartySlot: number;
  actionCursor: number;
  moveCursor: number;
  inputMode: "action" | "move" | "resolving";
  legalMoves: { moveId: string; power: number }[];
  opponent: {
    speciesId: string;
    level: number;
    currentHp: number;
    maxHp: number;
  };
}

export interface FireRedDecodedState {
  overworld: FireRedOverworldFields;
  /**
   * Collision around the player, or null when no map grid is loaded — during a
   * battle or a map transition there is genuinely nothing to report, and a
   * fabricated "all open" would be worse than an absent field.
   */
  surroundings: GbaCoreSurroundings | null;
  mapSize: { width: number; height: number } | null;
  /**
   * Every way off the loaded map — warp events (doors, stairs, mats) in player
   * coordinate space and edge connections — or null whenever the grid is,
   * because both decode from the same loaded-map state.
   */
  exits: {
    warps: { x: number; y: number; destinationMapId: string }[];
    connections: { direction: "north" | "south" | "west" | "east"; destinationMapId: string }[];
  } | null;
  mapIdentity: { mapGroup: number; mapNum: number; mapId: string } | null;
  /**
   * Everyone else standing on the loaded map. Null when no map identity
   * decoded to filter them by — absence, not an empty room.
   */
  objectEvents: FireRedObjectEvent[] | null;
  party: GbaCoreState["party"];
  inventory: GbaCoreInventoryEntry[];
  battle: FireRedDecodedBattle | null;
  dialogLines: string[];
  /** Current field text-printer position, or null outside field dialog. */
  dialogProgress: number | null;
  /**
   * True when the field script is holding the visible dialog for an A/B press
   * — the box has finished printing and an advance will land. False while text
   * is still printing, so a driver can wait instead of wasting presses.
   */
  waitingForDialogAdvance: boolean;
  menu: GbaCoreMenuState | null;
  /**
   * Machine-usable naming-screen keyboard state — the exact entered text and
   * the cursor — when one is active and past its loading callback. The menu
   * above presents the same screen for reading; this field is what `enter_text`
   * navigates by.
   */
  naming: GbaCoreNamingState | null;
  fieldInputReady: boolean;
}

const checkedView = (bytes: Uint8Array, expectedLength: number, label: string): DataView => {
  if (bytes.byteLength !== expectedLength) {
    throw new Error(`Expected a ${String(expectedLength)}-byte ${label} snapshot`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

const busOffset = (address: number, base: number, byteLength: number, width: number): number => {
  const offset = address - base;
  if (offset < 0 || offset + width > byteLength) {
    throw new Error(`FireRed RAM address 0x${address.toString(16)} is outside the snapshot`);
  }
  return offset;
};

const ewramOffset = (address: number, width = 1): number =>
  busOffset(address, GBA_EWRAM_BASE, GBA_EWRAM_SIZE, width);
const iwramOffset = (address: number, width = 1): number =>
  busOffset(address, GBA_IWRAM_BUS_ADDRESS, GBA_IWRAM_BYTE_LENGTH, width);

const validSpecies = (species: number): boolean => species > 0 && species <= MAX_SPECIES_ID;
const validMove = (move: number): boolean => move > 0 && move <= MAX_MOVE_ID;
const moveId = (move: number): string => `firered-move-${String(move)}`;
const speciesId = (species: number): string => `firered-species-${String(species)}`;
const normalizeThumbPointer = (pointer: number): number => pointer & 0xfffffffe;

const KNOWN_MAP_IDS: Readonly<Record<string, string>> = {
  "3:0": "pallet-town",
  // Verified in live play: pallet-town's north connection carries 3:19 and
  // walking through it lands on Route 1.
  "3:19": "route-1",
  "4:0": "pallet-town/players-house-1f",
  "4:1": "pallet-town/players-house-2f",
  "4:2": "pallet-town/rivals-house",
  "4:3": "pallet-town/professor-oaks-lab",
};

/** The stable id a map group/number pair is reported as everywhere. */
export function fireRedMapIdFor(mapGroup: number, mapNum: number): string {
  return (
    KNOWN_MAP_IDS[`${String(mapGroup)}:${String(mapNum)}`] ??
    `firered-map-${String(mapGroup)}-${String(mapNum)}`
  );
}

function decodeMapIdentity(ewram: DataView, iwram: DataView): FireRedDecodedState["mapIdentity"] {
  const saveBlock1Address = iwram.getUint32(iwramOffset(G_SAVE_BLOCK1_POINTER_ADDRESS, 4), true);
  if (saveBlock1Address === 0) return null;
  const location = ewramOffset(saveBlock1Address + 4, 2);
  const mapGroup = ewram.getUint8(location);
  const mapNum = ewram.getUint8(location + 1);
  return {
    mapGroup,
    mapNum,
    mapId: fireRedMapIdFor(mapGroup, mapNum),
  };
}

function decodeInventory(ewram: DataView, iwram: DataView): GbaCoreInventoryEntry[] {
  const saveBlock1Address = iwram.getUint32(iwramOffset(G_SAVE_BLOCK1_POINTER_ADDRESS, 4), true);
  const saveBlock2Address = iwram.getUint32(iwramOffset(G_SAVE_BLOCK2_POINTER_ADDRESS, 4), true);
  if (saveBlock1Address === 0 && saveBlock2Address === 0) return [];
  if (saveBlock1Address === 0 || saveBlock2Address === 0) {
    throw new Error("FireRed save-block pointers are only partially initialized");
  }
  const saveBlock1 = ewramOffset(saveBlock1Address, SAVE_BLOCK1_MINIMUM_LENGTH);
  const saveBlock2 = ewramOffset(saveBlock2Address, SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET + 4);
  const quantityKey = ewram.getUint32(saveBlock2 + SAVE_BLOCK2_ENCRYPTION_KEY_OFFSET, true) & 0xffff;
  const inventory: GbaCoreInventoryEntry[] = [];
  for (const pocket of BAG_POCKETS) {
    for (let slot = 0; slot < pocket.capacity; slot += 1) {
      const itemSlot = saveBlock1 + pocket.offset + slot * 4;
      const item = ewram.getUint16(itemSlot, true);
      if (item === 0) continue;
      const count = ewram.getUint16(itemSlot + 2, true) ^ quantityKey;
      if (item > MAX_ITEM_ID || count < 1 || count > 999) {
        throw new Error(`FireRed ${pocket.pocket} slot ${String(slot)} decoded outside the supported domain`);
      }
      inventory.push({
        pocket: pocket.pocket,
        itemId: `firered-item-${String(item)}`,
        count,
      });
    }
  }
  return inventory;
}

/** Read move power directly from the version-pinned ROM table. */
function decodeFireRedMovePower(romBytes: Uint8Array, move: number): number {
  if (!validMove(move)) throw new Error(`FireRed move ${String(move)} is outside the supported domain`);
  const offset = FIRERED_BATTLE_MOVES_ROM_OFFSET + move * FIRERED_BATTLE_MOVE_STRIDE + 1;
  const power = romBytes[offset];
  if (power === undefined) throw new Error("FireRed ROM is too short for the battle-move table");
  return power;
}

function decodePartyMember(
  ewram: DataView,
  romBytes: Uint8Array,
  slot: number,
): GbaCoreState["party"][number] {
  const base = ewramOffset(G_PLAYER_PARTY_ADDRESS + slot * POKEMON_BYTE_LENGTH, POKEMON_BYTE_LENGTH);
  const personality = ewram.getUint32(base, true);
  const otId = ewram.getUint32(base + 4, true);
  const expectedChecksum = ewram.getUint16(base + 0x1c, true);
  const key = personality ^ otId;
  const decrypted = new Uint8Array(BOX_SECURE_BYTE_LENGTH);
  const decryptedView = new DataView(decrypted.buffer);
  for (let offset = 0; offset < BOX_SECURE_BYTE_LENGTH; offset += 4) {
    decryptedView.setUint32(offset, ewram.getUint32(base + BOX_SECURE_OFFSET + offset, true) ^ key, true);
  }
  let checksum = 0;
  for (let offset = 0; offset < BOX_SECURE_BYTE_LENGTH; offset += 2) {
    checksum = (checksum + decryptedView.getUint16(offset, true)) & 0xffff;
  }
  if (checksum !== expectedChecksum) {
    throw new Error(`FireRed party slot ${String(slot)} failed its secure-data checksum`);
  }

  const order = SUBSTRUCT_ORDERS[personality % SUBSTRUCT_ORDERS.length];
  const growthIndex = order?.[0];
  const attacksIndex = order?.[1];
  if (growthIndex === undefined || attacksIndex === undefined) {
    throw new Error(`FireRed party slot ${String(slot)} has an invalid substruct order`);
  }
  const species = decryptedView.getUint16(growthIndex * 12, true);
  const moves = Array.from({ length: 4 }, (_, moveSlot) =>
    decryptedView.getUint16(attacksIndex * 12 + moveSlot * 2, true),
  ).filter(validMove);
  const level = ewram.getUint8(base + 0x54);
  const currentHp = ewram.getUint16(base + 0x56, true);
  const maxHp = ewram.getUint16(base + 0x58, true);
  if (
    !validSpecies(species) ||
    level < 1 ||
    level > 100 ||
    maxHp < 1 ||
    maxHp > 9_999 ||
    currentHp > maxHp ||
    moves.length === 0
  ) {
    throw new Error(`FireRed party slot ${String(slot)} decoded outside the supported domain`);
  }
  return {
    slot,
    speciesId: speciesId(species),
    level,
    currentHp,
    maxHp,
    status: currentHp === 0 ? "fainted" : "healthy",
    moves: moves.map((move) => ({ moveId: moveId(move), power: decodeFireRedMovePower(romBytes, move) })),
  };
}

function decodeParty(ewram: DataView, romBytes: Uint8Array): GbaCoreState["party"] {
  const count = ewram.getUint8(ewramOffset(G_PLAYER_PARTY_COUNT_ADDRESS));
  if (count > PARTY_CAPACITY) {
    throw new Error(`FireRed party count ${String(count)} exceeds capacity`);
  }
  return Array.from({ length: count }, (_, slot) => decodePartyMember(ewram, romBytes, slot));
}

interface DecodedBattleContext {
  battle: FireRedDecodedBattle;
  playerBattler: number;
  playerBattleMon: {
    currentHp: number;
    maxHp: number;
    moves: { moveId: string; power: number }[];
  };
}

function decodeBattleMon(
  ewram: DataView,
  romBytes: Uint8Array,
  battler: number,
): {
  species: number;
  level: number;
  currentHp: number;
  maxHp: number;
  moves: { moveId: string; power: number }[];
} {
  const base = ewramOffset(G_BATTLE_MONS_ADDRESS + battler * BATTLE_MON_BYTE_LENGTH, BATTLE_MON_BYTE_LENGTH);
  const species = ewram.getUint16(base, true);
  const level = ewram.getUint8(base + 0x2a);
  const currentHp = ewram.getUint16(base + 0x28, true);
  const maxHp = ewram.getUint16(base + 0x2c, true);
  const moves = Array.from({ length: 4 }, (_, slot) => ({
    move: ewram.getUint16(base + 0x0c + slot * 2, true),
    pp: ewram.getUint8(base + 0x24 + slot),
  }))
    .filter(({ move }) => validMove(move))
    .map(({ move, pp }) => ({
      moveId: moveId(move),
      power: pp > 0 ? decodeFireRedMovePower(romBytes, move) : -1,
    }));
  if (!validSpecies(species) || level < 1 || level > 100 || maxHp < 1 || maxHp > 9_999 || currentHp > maxHp) {
    throw new Error(`FireRed battler ${String(battler)} decoded outside the supported domain`);
  }
  const legalMoves = moves.filter(({ power }) => power >= 0);
  return {
    species,
    level,
    currentHp,
    maxHp,
    moves:
      legalMoves.length > 0
        ? legalMoves
        : [{ moveId: moveId(STRUGGLE_MOVE_ID), power: decodeFireRedMovePower(romBytes, STRUGGLE_MOVE_ID) }],
  };
}

function battleMonIsUninitialized(ewram: DataView, battler: number): boolean {
  const base = ewramOffset(G_BATTLE_MONS_ADDRESS + battler * BATTLE_MON_BYTE_LENGTH, BATTLE_MON_BYTE_LENGTH);
  return (
    ewram.getUint16(base, true) === 0 &&
    ewram.getUint8(base + 0x2a) === 0 &&
    ewram.getUint16(base + 0x28, true) === 0 &&
    ewram.getUint16(base + 0x2c, true) === 0
  );
}

function decodeBattle(
  ewram: DataView,
  iwram: DataView,
  romBytes: Uint8Array,
  party: GbaCoreState["party"],
): DecodedBattleContext | null {
  const inBattle = (iwram.getUint8(iwramOffset(G_MAIN_IN_BATTLE_ADDRESS)) & 0x02) !== 0;
  if (!inBattle) return null;

  const battlerCount = ewram.getUint8(ewramOffset(G_BATTLERS_COUNT_ADDRESS));
  if (battlerCount < 2 || battlerCount > 4) {
    throw new Error(`FireRed battler count ${String(battlerCount)} is invalid`);
  }
  const positionsOffset = ewramOffset(G_BATTLER_POSITIONS_ADDRESS, battlerCount);
  const positions = Array.from({ length: battlerCount }, (_, battler) =>
    ewram.getUint8(positionsOffset + battler),
  );
  if (positions.some((position) => position > 3) || new Set(positions).size !== positions.length) {
    throw new Error("FireRed battler positions are invalid");
  }
  const playerBattler = positions.findIndex((position) => position === 0);
  const opponentBattler = positions.findIndex((position) => position === 1);
  if (playerBattler < 0 || opponentBattler < 0) {
    throw new Error("FireRed battle has no primary player/opponent pair");
  }

  // `gMain.inBattle` is asserted before the battler records are populated
  // during the battle-scene handoff. All-zero records are the exact
  // initialization sentinel, not a valid battler and not corruption. The
  // field callback is not input-ready in this window, so the governed driver
  // advances frames without issuing a game input. Any partially populated
  // out-of-domain record still fails closed below.
  const outcome = ewram.getUint8(ewramOffset(G_BATTLE_OUTCOME_ADDRESS));
  if (
    outcome === 0 &&
    battleMonIsUninitialized(ewram, playerBattler) &&
    battleMonIsUninitialized(ewram, opponentBattler)
  ) {
    return null;
  }

  const partyIndexesOffset = ewramOffset(G_BATTLER_PARTY_INDEXES_ADDRESS, battlerCount * 2);
  const activePartySlot = ewram.getUint16(partyIndexesOffset + playerBattler * 2, true);
  if (activePartySlot >= party.length) {
    throw new Error(`FireRed active party slot ${String(activePartySlot)} is invalid`);
  }
  const playerMon = decodeBattleMon(ewram, romBytes, playerBattler);
  const opponentMon = decodeBattleMon(ewram, romBytes, opponentBattler);
  const actionCursor = ewram.getUint8(ewramOffset(G_ACTION_SELECTION_CURSOR_ADDRESS + playerBattler));
  const moveCursor = ewram.getUint8(ewramOffset(G_MOVE_SELECTION_CURSOR_ADDRESS + playerBattler));
  if (actionCursor > 3 || moveCursor > 3 || outcome > 10) {
    throw new Error("FireRed battle controls decoded outside the supported domain");
  }

  const execFlags = ewram.getUint32(ewramOffset(G_BATTLE_CONTROLLER_EXEC_FLAGS_ADDRESS, 4), true);
  const command = ewram.getUint8(
    ewramOffset(G_BATTLE_BUFFER_A_ADDRESS + playerBattler * BATTLE_BUFFER_BYTE_LENGTH),
  );
  const playerControllerPending = (execFlags & (1 << playerBattler)) !== 0;
  const inputMode =
    playerControllerPending && command === CONTROLLER_CHOOSE_ACTION
      ? "action"
      : playerControllerPending && command === CONTROLLER_CHOOSE_MOVE
        ? "move"
        : "resolving";
  return {
    playerBattler,
    playerBattleMon: {
      currentHp: playerMon.currentHp,
      maxHp: playerMon.maxHp,
      moves: playerMon.moves,
    },
    battle: {
      battleTypeFlags: ewram.getUint32(ewramOffset(G_BATTLE_TYPE_FLAGS_ADDRESS, 4), true),
      outcome,
      activePartySlot,
      actionCursor,
      moveCursor,
      inputMode,
      legalMoves: playerMon.moves,
      opponent: {
        speciesId: speciesId(opponentMon.species),
        level: opponentMon.level,
        currentHp: opponentMon.currentHp,
        maxHp: opponentMon.maxHp,
      },
    },
  };
}

/**
 * The Western Gen III accented range, straight from the decomp's charmap. The
 * game spells "POKéMON" with 0x1B, so leaving these out rendered the single
 * most common word in the script as "POK�MON".
 */
const ACCENTED_CHARACTERS: Readonly<Record<number, string>> = {
  0x01: "À",
  0x02: "Á",
  0x03: "Â",
  0x04: "Ç",
  0x05: "È",
  0x06: "É",
  0x07: "Ê",
  0x08: "Ë",
  0x09: "Ì",
  0x0b: "Î",
  0x0c: "Ï",
  0x0d: "Ò",
  0x0e: "Ó",
  0x0f: "Ô",
  0x10: "Œ",
  0x11: "Ù",
  0x12: "Ú",
  0x13: "Û",
  0x14: "Ñ",
  0x15: "ß",
  0x16: "à",
  0x17: "á",
  0x19: "ç",
  0x1a: "è",
  0x1b: "é",
  0x1c: "ê",
  0x1d: "ë",
  0x1e: "ì",
  0x20: "î",
  0x21: "ï",
  0x22: "ò",
  0x23: "ó",
  0x24: "ô",
  0x25: "œ",
  0x26: "ù",
  0x27: "ú",
  0x28: "û",
  0x29: "ñ",
  0x2a: "º",
  0x2b: "ª",
  0x51: "¿",
  0x52: "¡",
  0x5a: "Í",
  0x68: "â",
  0x6f: "í",
  0xf1: "Ä",
  0xf2: "Ö",
  0xf3: "Ü",
  0xf4: "ä",
  0xf5: "ö",
  0xf6: "ü",
};

const decodeCharacter = (value: number): string | null => {
  if (value === 0) return " ";
  if (value >= 0xa1 && value <= 0xaa) return String(value - 0xa1);
  if (value >= 0xbb && value <= 0xd4) return String.fromCharCode(65 + value - 0xbb);
  if (value >= 0xd5 && value <= 0xee) return String.fromCharCode(97 + value - 0xd5);
  const accented = ACCENTED_CHARACTERS[value];
  if (accented !== undefined) return accented;
  const punctuation: Record<number, string> = {
    0x2d: "&",
    0x2e: "+",
    0x35: "=",
    0x36: ";",
    0x5b: "%",
    0x5c: "(",
    0x5d: ")",
    0xab: "!",
    0xac: "?",
    0xad: ".",
    0xae: "-",
    0xaf: "·",
    0xb0: "…",
    0xb4: "'",
    0xb5: "♂",
    0xb6: "♀",
    0xb8: ",",
    0xba: "/",
    0xf0: ":",
  };
  return punctuation[value] ?? null;
};

const EXTENDED_CONTROL_ARG_COUNTS: Readonly<Record<number, number>> = {
  0x01: 1,
  0x02: 1,
  0x03: 1,
  0x04: 3,
  0x05: 1,
  0x06: 1,
  0x07: 0,
  0x08: 1,
  0x09: 0,
  0x0a: 0,
  0x0b: 2,
  0x0c: 1,
  0x0d: 1,
  0x0e: 1,
  0x0f: 1,
  0x10: 2,
  0x11: 0,
  0x12: 1,
  0x13: 1,
  0x14: 1,
  0x15: 0,
  0x16: 0,
  0x17: 0,
  0x18: 0,
};

/** Decode bounded English FireRed text after placeholder expansion. */
export function decodeFireRedText(bytes: Uint8Array): string[] {
  let text = "";
  for (let index = 0; index < bytes.length && text.length < 4_096; index += 1) {
    const value = bytes[index]!;
    if (value === 0xff) break;
    if (value === 0xfe || value === 0xfa || value === 0xfb) {
      text += "\n";
      continue;
    }
    if (value === 0xfc) {
      const code = bytes[index + 1];
      if (code === undefined) break;
      const argCount = EXTENDED_CONTROL_ARG_COUNTS[code];
      if (argCount === undefined) break;
      index += 1 + argCount;
      continue;
    }
    if (value === 0xf8 || value === 0xf9 || value === 0xfd) {
      index += 1;
      continue;
    }
    text += decodeCharacter(value) ?? "�";
  }
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0)
    .slice(0, 8)
    .map((line) => line.slice(0, 512));
  return lines;
}

function readEwramBytes(ewram: DataView, address: number, length: number): Uint8Array {
  const offset = ewramOffset(address, length);
  return new Uint8Array(ewram.buffer, ewram.byteOffset + offset, length);
}

interface DecodedDialog {
  lines: string[];
  progress: number | null;
  /**
   * True when the field script is parked on the wait-for-A/B native — the
   * visible box has finished printing and the game will accept an advance.
   * Always false for battle text, which resolves on its own clock.
   */
  waitingForAdvance: boolean;
}

function decodeDialog(ewram: DataView, iwram: DataView, battle: DecodedBattleContext | null): DecodedDialog {
  if (battle) {
    if (battle.battle.inputMode !== "resolving")
      return { lines: [], progress: null, waitingForAdvance: false };
    return {
      lines: decodeFireRedText(readEwramBytes(ewram, G_DISPLAYED_STRING_BATTLE_ADDRESS, 0x12c)),
      progress: null,
      waitingForAdvance: false,
    };
  }
  const messageBoxType = ewram.getUint8(ewramOffset(S_MESSAGE_BOX_TYPE_ADDRESS));
  if (messageBoxType > 2)
    throw new Error(`FireRed field message-box type ${String(messageBoxType)} is invalid`);
  // Scripted MSGBOX flows can keep printer 0 active while the field-message
  // helper's private type byte is already hidden. The text-printer active bit
  // is the authoritative second signal for the visible dialog in that state.
  const printer0Active = ewram.getUint8(ewramOffset(S_TEXT_PRINTERS_ADDRESS + 0x1b));
  if (printer0Active > 1) {
    throw new Error(`FireRed text-printer active flag ${String(printer0Active)} is invalid`);
  }
  const scriptMode = iwram.getUint8(iwramOffset(S_GLOBAL_SCRIPT_CONTEXT_ADDRESS + 1));
  const scriptNative = normalizeThumbPointer(
    iwram.getUint32(iwramOffset(S_GLOBAL_SCRIPT_CONTEXT_ADDRESS + 4, 4), true),
  );
  const waitingForAdvance = scriptMode === 2 && scriptNative === NATIVE_WAIT_FOR_A_OR_B_PRESS;
  if (messageBoxType === 0 && printer0Active === 0 && !waitingForAdvance) {
    return { lines: [], progress: null, waitingForAdvance: false };
  }
  const lines = decodeFireRedText(readEwramBytes(ewram, G_STRING_VAR_4_ADDRESS, 0x3e8));
  return {
    lines: lines.length > 0 ? lines : ["Field dialog"],
    progress: ewram.getUint32(ewramOffset(S_TEXT_PRINTERS_ADDRESS, 4), true),
    waitingForAdvance,
  };
}

function hasActiveTask(iwram: DataView, functionAddress: number): boolean {
  const tasks = iwramOffset(G_TASKS_ADDRESS, TASK_CAPACITY * TASK_BYTE_LENGTH);
  for (let index = 0; index < TASK_CAPACITY; index += 1) {
    const task = tasks + index * TASK_BYTE_LENGTH;
    if (
      iwram.getUint8(task + 4) === 1 &&
      normalizeThumbPointer(iwram.getUint32(task, true)) === functionAddress
    ) {
      return true;
    }
  }
  return false;
}

function mainCallback2(iwram: DataView): number {
  return normalizeThumbPointer(iwram.getUint32(iwramOffset(G_MAIN_ADDRESS + 4, 4), true));
}

/**
 * The naming screen runs under its own main callback while the overworld
 * decoder keeps reporting the stale field state underneath it. Left undecoded,
 * every keyboard press read as "position unchanged" — the harness told him
 * nothing happened while the screen visibly typed. This surfaces it as a menu:
 * what is typed so far, which keyboard page is up, and what is being named.
 */
interface DecodedNaming {
  menu: GbaCoreMenuState;
  /** Machine-usable keyboard state; null while the screen is still loading. */
  state: GbaCoreNamingState | null;
}

/**
 * The exact entered text, byte for byte. The display path collapses
 * whitespace, which would make a name containing a space compare wrongly
 * against what a driver asked to type.
 */
function decodeNamingBuffer(bytes: Uint8Array): string {
  let text = "";
  for (const value of bytes) {
    if (value === 0xff) break;
    text += decodeCharacter(value) ?? "�";
  }
  return text;
}

function decodeNamingScreen(ewram: DataView, iwram: DataView): DecodedNaming | null {
  const callback = mainCallback2(iwram);
  if (callback !== CB2_NAMING_SCREEN && callback !== CB2_LOAD_NAMING_SCREEN) return null;
  // During the load callback the heap block is allocated but its page and text
  // bytes are not yet initialized, so only presence is reported.
  if (callback === CB2_LOAD_NAMING_SCREEN) {
    return {
      menu: {
        menuId: "naming-screen",
        cursor: 0,
        entries: [{ id: "loading", label: "the naming screen is still loading" }],
      },
      state: null,
    };
  }
  const dataAddress = ewram.getUint32(ewramOffset(S_NAMING_SCREEN_POINTER_ADDRESS, 4), true);
  if (dataAddress === 0) {
    throw new Error("FireRed naming screen is running without its data block");
  }
  const structBase = ewramOffset(dataAddress, NAMING_SCREEN_TEMPLATE_NUM_OFFSET + 1);
  const bufferBytes = readEwramBytes(
    ewram,
    dataAddress + NAMING_SCREEN_TEXT_BUFFER_OFFSET,
    NAMING_SCREEN_TEXT_BUFFER_BYTE_LENGTH,
  );
  const typed = decodeFireRedText(bufferBytes).join(" ").trim();
  const page = NAMING_SCREEN_PAGES[ewram.getUint8(structBase + NAMING_SCREEN_CURRENT_PAGE_OFFSET)];
  const subject = NAMING_SCREEN_SUBJECTS[ewram.getUint8(structBase + NAMING_SCREEN_TEMPLATE_NUM_OFFSET)];
  if (page === undefined || subject === undefined) {
    throw new Error("FireRed naming screen decoded outside the supported domain");
  }
  const column = ewram.getUint8(ewramOffset(G_SPRITES_CURSOR_COLUMN_ADDRESS));
  const row = ewram.getUint8(ewramOffset(G_SPRITES_CURSOR_ROW_ADDRESS));
  if (column > NAMING_SCREEN_MAX_COLUMN || row > NAMING_SCREEN_MAX_ROW) {
    throw new Error("FireRed naming-screen cursor is outside the keyboard");
  }
  return {
    menu: {
      menuId: "naming-screen",
      cursor: 0,
      entries: [
        { id: "typed-text", label: typed.length > 0 ? `typed so far: "${typed}"` : "nothing typed yet" },
        { id: "keyboard-page", label: `${page} keyboard` },
        { id: "naming", label: `naming ${subject}` },
      ],
    },
    state: { text: decodeNamingBuffer(bufferBytes), page, row, column },
  };
}

function decodeStartMenu(ewram: DataView, iwram: DataView): GbaCoreMenuState | null {
  if (!hasActiveTask(iwram, TASK_START_MENU_HANDLE_INPUT)) return null;
  const callback = ewram.getUint32(ewramOffset(S_START_MENU_CALLBACK_ADDRESS, 4), true);
  if (callback < 0x08000000 || callback >= 0x0a000000) {
    throw new Error("FireRed active start-menu callback is outside ROM");
  }
  const count = ewram.getUint8(ewramOffset(S_START_MENU_COUNT_ADDRESS));
  const cursor = ewram.getUint8(ewramOffset(S_START_MENU_CURSOR_ADDRESS));
  if (count < 1 || count > START_MENU_LABELS.length || cursor >= count) {
    throw new Error("FireRed start-menu shape is invalid");
  }
  const entries = Array.from({ length: count }, (_, index) => {
    const option = ewram.getUint8(ewramOffset(S_START_MENU_ORDER_ADDRESS + index));
    const label = START_MENU_LABELS[option];
    if (label === undefined) throw new Error(`FireRed start-menu option ${String(option)} is invalid`);
    return { id: `start-menu-${String(option)}`, label };
  });
  return { menuId: "start-menu", cursor, entries };
}

function decodeHelpSystem(ewram: DataView): GbaCoreMenuState | null {
  const open = ewram.getUint8(ewramOffset(S_IN_HELP_SYSTEM_ADDRESS));
  if (open === 0) return null;
  if (open !== 1) throw new Error(`FireRed help-system flag ${String(open)} is invalid`);
  return { menuId: "help-system", cursor: 0, entries: [] };
}

function decodePartyMenu(
  ewram: DataView,
  iwram: DataView,
  party: GbaCoreState["party"],
): GbaCoreMenuState | null {
  // The similarly named `sInPartyMenu` EWRAM symbol belongs to Pokémon
  // Storage and is not an indicator for the field party screen. The active
  // main callback is authoritative for the standalone party menu.
  if (mainCallback2(iwram) !== CB2_UPDATE_PARTY_MENU) return null;
  const slot = ewram.getInt8(ewramOffset(G_PARTY_MENU_ADDRESS + 9));
  if (slot < 0 || slot > party.length) throw new Error(`FireRed party-menu slot ${String(slot)} is invalid`);
  return {
    menuId: "party-menu",
    cursor: slot,
    entries: [
      ...party.map((member) => ({ id: `party-slot-${String(member.slot)}`, label: member.speciesId })),
      { id: "cancel", label: "Cancel" },
    ],
  };
}

function decodeBagMenu(ewram: DataView, inventory: GbaCoreInventoryEntry[]): GbaCoreMenuState | null {
  const base = ewramOffset(G_BAG_MENU_STATE_ADDRESS, 0x14);
  const open = ewram.getUint8(base + 5);
  if (open === 0) return null;
  if (open !== 1) throw new Error(`FireRed bag-open flag ${String(open)} is invalid`);
  const pocket = ewram.getUint16(base + 6, true);
  if (pocket > 2) throw new Error(`FireRed bag pocket ${String(pocket)} is invalid`);
  const pocketName = BAG_POCKETS[pocket]!.pocket;
  const items = inventory.filter((entry) => entry.pocket === pocketName);
  const cursor = ewram.getUint16(base + 8 + pocket * 2, true) + ewram.getUint16(base + 14 + pocket * 2, true);
  if (cursor > items.length) throw new Error(`FireRed bag cursor ${String(cursor)} is invalid`);
  const entries = [
    ...items.map((entry) => ({
      id: entry.itemId,
      label: `${entry.itemId} ×${String(entry.count)}`,
    })),
    { id: "cancel", label: "Cancel" },
  ];
  const start = Math.max(0, Math.min(cursor - 7, entries.length - 16));
  return {
    menuId: `bag-${pocketName}`,
    cursor,
    entries: entries.slice(start, start + 16),
  };
}

function decodeBattleMenu(battle: DecodedBattleContext | null): GbaCoreMenuState | null {
  if (!battle) return null;
  if (battle.battle.inputMode === "action") {
    return {
      menuId: "battle-action-menu",
      cursor: battle.battle.actionCursor,
      entries: ACTION_MENU_ENTRIES.map((entry) => ({ ...entry })),
    };
  }
  if (battle.battle.inputMode === "move") {
    return {
      menuId: "battle-move-menu",
      cursor: Math.min(battle.battle.moveCursor, battle.battle.legalMoves.length - 1),
      entries: battle.battle.legalMoves.map((move) => ({ id: move.moveId, label: move.moveId })),
    };
  }
  return null;
}

function decodeMenu(
  ewram: DataView,
  iwram: DataView,
  party: GbaCoreState["party"],
  inventory: GbaCoreInventoryEntry[],
  battle: DecodedBattleContext | null,
): GbaCoreMenuState | null {
  return (
    decodePartyMenu(ewram, iwram, party) ??
    decodeBagMenu(ewram, inventory) ??
    decodeBattleMenu(battle) ??
    decodeStartMenu(ewram, iwram)
  );
}

/** Decode the supported FireRed state surface, rejecting any uncertain shape. */
export function decodeFireRedState(
  snapshot: FireRedMemorySnapshot,
  romBytes: Uint8Array,
): FireRedDecodedState {
  const ewram = checkedView(snapshot.ewram, GBA_EWRAM_SIZE, "EWRAM");
  const iwram = checkedView(snapshot.iwram, GBA_IWRAM_BYTE_LENGTH, "IWRAM");
  const party = decodeParty(ewram, romBytes);
  const inventory = decodeInventory(ewram, iwram);
  const mapIdentity = decodeMapIdentity(ewram, iwram);
  const battleContext = decodeBattle(ewram, iwram, romBytes, party);
  if (battleContext) {
    const active = party[battleContext.battle.activePartySlot];
    if (!active) throw new Error("FireRed active party member is absent");
    active.currentHp = battleContext.playerBattleMon.currentHp;
    active.maxHp = battleContext.playerBattleMon.maxHp;
    active.status = active.currentHp === 0 ? "fainted" : "healthy";
    active.moves = battleContext.playerBattleMon.moves;
  }
  const overworld = decodeFireRedOverworld(snapshot.ewram);
  // A missing grid is a normal state (battle, mid-warp), not a decode failure,
  // so this reports absence rather than propagating the throw.
  let surroundings: GbaCoreSurroundings | null = null;
  let mapSize: { width: number; height: number } | null = null;
  let exits: FireRedDecodedState["exits"] = null;
  try {
    const grid = decodeFireRedMapGrid(snapshot.iwram, snapshot.ewram);
    surroundings = fireRedSurroundings(grid, overworld.x, overworld.y, overworld.facing);
    mapSize = { width: grid.mapWidth, height: grid.mapHeight };
    const rawExits = decodeFireRedMapExits(snapshot.ewram, romBytes, grid);
    if (rawExits !== null) {
      exits = {
        warps: rawExits.warps.map((warp) => ({
          x: warp.x,
          y: warp.y,
          destinationMapId: fireRedMapIdFor(warp.destinationMapGroup, warp.destinationMapNum),
        })),
        connections: rawExits.connections.map((connection) => ({
          direction: connection.direction,
          destinationMapId: fireRedMapIdFor(connection.destinationMapGroup, connection.destinationMapNum),
        })),
      };
    }
  } catch {
    surroundings = null;
    mapSize = null;
    exits = null;
  }
  const dialog = decodeDialog(ewram, iwram, battleContext);
  const namingScreen = decodeNamingScreen(ewram, iwram);
  const helpSystem = decodeHelpSystem(ewram);
  return {
    overworld,
    surroundings,
    mapSize,
    exits,
    mapIdentity,
    objectEvents: mapIdentity === null ? null : decodeFireRedObjectEvents(snapshot.ewram, mapIdentity),
    party,
    inventory,
    battle: battleContext?.battle ?? null,
    dialogLines: dialog.lines,
    dialogProgress: dialog.progress,
    waitingForDialogAdvance: dialog.waitingForAdvance,
    naming: namingScreen?.state ?? null,
    // HELP overlays whichever callback/menu was active, so its own flag has
    // priority over the stale underlying screen state.
    menu: helpSystem ?? namingScreen?.menu ?? decodeMenu(ewram, iwram, party, inventory, battleContext),
    fieldInputReady:
      helpSystem === null &&
      mainCallback2(iwram) === CB2_OVERWORLD &&
      iwram.getUint8(iwramOffset(S_LOCK_FIELD_CONTROLS_ADDRESS)) === 0,
  };
}
