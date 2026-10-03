import { expect, it } from "vitest";
import { hireDisplayName } from "../src/captain/hire-name.ts";

it("preserves human names across languages without an ASCII-only naming rule", () => {
  for (const name of ["美咲", "نور", "Ngọc", "Jean-Luc", "O’Connor", "李 明"])
    expect(hireDisplayName(` ${name} `)).toBe(name);
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
