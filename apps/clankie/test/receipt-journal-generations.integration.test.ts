import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SeatCallReceipts } from "../src/seat-call-receipts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(`${root}/`, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-receipt-generations-"));
  roots.push(root);
  const path = join(root, "receipts.json"),
    id = randomUUID();
  const first = new SeatCallReceipts(path),
    second = new SeatCallReceipts(path);
  first.begin(id, "message_seat", { text: "original" }, "operator");
  first.settle(id, { content: [{ type: "text", text: "before" }] });
  return { path, id, first, second, read: (store = first) => store.read(id, "message_seat", "operator") };
}

it("keeps returned result mutations private across unchanged durable reads", () => {
  const f = fixture();
  const original = readFileSync(f.path, "utf8");
  const result = f.read();
  result.content[0] = { type: "text", text: "uncommitted" };
  expect(f.read().content).toEqual([{ type: "text", text: "before" }]);
  expect(readFileSync(f.path, "utf8")).toBe(original);
  expect(f.first.begin(f.id, "message_seat", { text: "original" }, "operator")?.content).toEqual([
    { type: "text", text: "before" },
  ]);
});

it("observes an independent writer after warming both journal generations", () => {
  const f = fixture();
  f.read();
  f.read(f.second);
  f.second.settle(f.id, { content: [{ type: "text", text: "second" }] });
  expect(f.read().content).toEqual([{ type: "text", text: "second" }]);
  f.first.settle(f.id, { content: [{ type: "text", text: "third" }] });
  expect(f.read(f.second).content).toEqual([{ type: "text", text: "third" }]);
});

it("detects same-size in-place edits even when mtime is restored", () => {
  const f = fixture();
  f.read();
  const info = statSync(f.path);
  const bytes = readFileSync(f.path, "utf8");
  writeFileSync(f.path, bytes.replace('"before"', '"edited"'));
  utimesSync(f.path, info.atime, info.mtime);
  expect(statSync(f.path).size).toBe(info.size);
  expect(f.read().content).toEqual([{ type: "text", text: "edited" }]);
});

it("checks replacement identity, corruption and deletion instead of returning a cached success", () => {
  const f = fixture();
  f.read();
  const original = readFileSync(f.path, "utf8"),
    replacement = `${f.path}.replacement`;
  writeFileSync(replacement, original.replace('"before"', '"newest"'));
  renameSync(replacement, f.path);
  expect(f.read().content).toEqual([{ type: "text", text: "newest" }]);
  writeFileSync(f.path, "not json");
  expect(() => f.read()).toThrow("receipts are unreadable");
  writeFileSync(f.path, JSON.stringify([{ id: f.id }]));
  expect(() => f.read()).toThrow("receipts are unreadable");
  writeFileSync(f.path, original);
  expect(f.read().content).toEqual([{ type: "text", text: "before" }]);
  rmSync(f.path);
  expect(f.read().isError).toBe(true);
  writeFileSync(f.path, original);
  expect(f.read().content).toEqual([{ type: "text", text: "before" }]);
});

it("reads unchanged journal bytes once across repeated public receipt lookups", () => {
  const f = fixture();
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("../../../scripts/dependency-types.mjs", import.meta.url)),
        fileURLToPath(new URL("./fixtures/receipt-read-count.mjs", import.meta.url)),
        f.path,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(result.reads).toBe(1);
  expect(result.results).toHaveLength(10);
  for (const read of result.results) expect(read.content).toEqual([{ type: "text", text: "before" }]);
});
