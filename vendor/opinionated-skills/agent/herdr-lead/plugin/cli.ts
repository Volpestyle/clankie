#!/usr/bin/env -S node

import { spawnSync } from "node:child_process";
import { BOARD_LABEL, findBoardPane } from "./runtime.ts";

const command = process.argv[2] || "";
const args = process.argv.slice(3);

function setTarget(): void {
  process.env.HERD_LEAD_TARGET ||= process.env.HERDR_PANE_ID || "";
}

function renamePane(pane: string, label?: string): void {
  spawnSync("herdr", ["pane", "rename", pane, ...(label ? [label] : ["--clear"])], { stdio: "ignore" });
}

async function main(): Promise<void> {
  if (command === "roster") {
    const { main: roster } = await import("./roster.ts");
    roster(args);
    return;
  }
  if (command === "state") {
    process.argv.splice(2, process.argv.length - 2, ...args);
    await import("./digest.ts");
    return;
  }
  if (command === "split" || command === "open") {
    setTarget();
    await import("./open.ts");
    return;
  }
  if (command === "focus") {
    setTarget();
    await import("./focus.ts");
    return;
  }
  if (command === "-h" || command === "--help") {
    console.log("herdr-lead          run the board right here, in this pane");
    console.log("herdr-lead split    open it as a separate pane beside this one");
    console.log("herdr-lead focus    jump to the board, or back from it");
    console.log("herdr-lead state    print the board's data as a digest (--json, --fresh)");
    console.log("herdr-lead roster   read a fresh compact census (--agents-only, --status, --recaps, --json)");
    return;
  }

  const pane = process.env.HERDR_PANE_ID || "";
  const open = await findBoardPane(pane).catch(() => "");
  if (open) {
    console.error(`board already open in ${open} — herdr-lead focus jumps to it`);
    console.log(open);
    return;
  }
  if (pane) {
    const result = spawnSync("herdr", ["pane", "get", pane], { encoding: "utf8" });
    let prior = "";
    try {
      prior = (JSON.parse(result.stdout) as { result?: { pane?: { label?: string } } }).result?.pane?.label || "";
    } catch {}
    renamePane(pane, BOARD_LABEL);
    process.on("exit", () => renamePane(pane, prior));
  }
  await import("./dash.ts");
}

await main();
