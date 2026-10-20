import { expect, it } from "vitest";
import { hireDisplayName, hirePaneLabel } from "../src/captain/hire-name.ts";

it("preserves human names across languages without an ASCII-only naming rule", () => {
  for (const name of ["美咲", "نور", "Ngọc", "Jean-Luc", "O’Connor", "李 明", "美咲 / نور", "Noor: نور"])
    expect(hireDisplayName(` ${name} `)).toBe(name);
});

it("keeps routing, harnesses and worktree paths out of hire captions", () => {
  expect(hirePaneLabel("Wren", "VUH-2541 Chats drawer | /tmp/wt-vuh2541")).toBe("Wren · Chats drawer");
  expect(hirePaneLabel("Ines", "Codex VUH-2541 C:\\dev\\wt-vuh2541", "reviewer")).toBe("Ines · reviewer");
  expect(hirePaneLabel("Wren", undefined, "engineer")).toBe("Wren · engineer");
  expect(hirePaneLabel("Wren")).toBe("Wren · Work");
  for (const title of ["Claude Code", "✳ Claude Code", "Codex", "Wren VUH-2541", "Chats | /tmp/worktree"])
    expect(hireDisplayName(title)).toMatch(/^(Ari|Mei|Noor|Ravi|Sora|Zuri)$/u);
});
it("replaces legacy routing labels with stable human display names", () => {
  for (const label of [
    "fleet:pc/vuh1381-canary",
    "vuh1381-canary",
    "term_worker",
    "session-abcd",
    "pc/worker",
  ]) {
    expect(hireDisplayName(label)).toMatch(/^(Ari|Mei|Noor|Ravi|Sora|Zuri)$/u);
    expect(hireDisplayName(label)).toBe(hireDisplayName(label));
  }
});

it("uses a valid stable fallback for blank, reserved, oversized and control-bearing names", () => {
  for (const name of ["", "   ", "Clyde", "Discord", "x".repeat(81), "Noor\n", "Mei\u0000"]) {
    expect(hireDisplayName(name)).toMatch(/^(Ari|Mei|Noor|Ravi|Sora|Zuri)$/u);
    expect(hireDisplayName(name)).toBe(hireDisplayName(name));
  }
});
