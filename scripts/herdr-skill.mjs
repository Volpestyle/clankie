import { join, resolve } from "node:path";
import { installHerdrRelease } from "../apps/clankie/src/herdr-release.ts";
import pin from "./release/herdr.json" with { type: "json" };
import { bundleHerdrSkill } from "./release/herdr-skill.mjs";

const root = resolve(import.meta.dirname, "..");
const binary = join(root, ".data/herdr/bin/herdr");
// Reuse only checksum-matching bytes; fetch the official pin on a fresh checkout.
await installHerdrRelease(binary, pin.release);
await bundleHerdrSkill(root, binary, pin.release.version, process.argv.includes("--check"));
