export interface CheckReportLine {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remediation?: string;
}

/**
 * Shared PASS/FAIL printer for readiness and live-proof CLIs. JSON mode dumps
 * the supplied payload; text mode prints one line per check.
 */
export function writeCheckReport(input: {
  checks: readonly CheckReportLine[];
  json: boolean;
  jsonPayload: unknown;
  title: string;
  outcome: string;
  preamble?: string;
  epilogue?: string;
  minNameWidth?: number;
  write?: (text: string) => void;
}): void {
  const write = input.write ?? ((text: string) => process.stdout.write(text));
  if (input.json) {
    write(`${JSON.stringify(input.jsonPayload, null, 2)}\n`);
    return;
  }
  if (input.preamble !== undefined) write(`${input.preamble}\n`);
  const width = Math.max(input.minNameWidth ?? 0, ...input.checks.map((check) => check.name.length));
  for (const check of input.checks) {
    write(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}\n`);
    if (!check.ok && check.remediation !== undefined) {
      write(`      ${"".padEnd(width)}  ${check.remediation}\n`);
    }
  }
  write(`\n${input.title}: ${input.outcome}\n`);
  if (input.epilogue !== undefined) write(input.epilogue);
}
