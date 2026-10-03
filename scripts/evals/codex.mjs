#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { codexAccounts, selectLiveCodexAccount } from "../../packages/settings/src/codex-accounts.ts";
import { plan, preflightResumeInputs, run, usageGate } from "./run.mjs";

/** One account per campaign, including retries and guard waits. Never rotate after a stop. */
export async function codexCampaign(args, runCampaign = run) {
  const flags = [...args];
  const index = flags.indexOf("--account");
  let label;
  if (index >= 0) {
    label = flags[index + 1];
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(label ?? "")) throw Error("--account needs a registered label");
    flags.splice(index, 2);
  }
  const options = plan(["--harness", "codex", ...flags]);
  if (options.harness !== "codex") throw Error("This entry point runs Codex campaigns only");
  if (options.accounts) {
    if (label) throw Error("Choose --account or --accounts, not both");
    return options.dryRun ? options : await runCampaign(options);
  }
  if (options.dryRun) return { ...options, account: label ?? "auto" };
  preflightResumeInputs(options);
  const selected = await selectLiveCodexAccount(codexAccounts(), label);
  const age = selected.observedAt === null ? Infinity : Date.now() - Date.parse(selected.observedAt);
  const rate = age >= -60_000 && age <= 24 * 3600_000 ? structuredClone(selected.rateLimits) : null;
  if (rate) {
    for (const window of ["five_hour", "seven_day"]) {
      if (rate.resets[window] !== null && rate.resets[window] * 1000 <= Date.now()) rate[window] = 0;
    }
    if (selected.headroom > 0) rate.limited = false;
  }
  const gate = usageGate(rate, options.stopAt);
  if (gate) throw Error(gate.stop ?? `${gate.reason}; start this campaign after the reset`);
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = selected.home;
  try {
    return await runCampaign({ ...options, account: { label: selected.label, home: selected.home } });
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await codexCampaign(process.argv.slice(2));
    if (result.dryRun) console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
